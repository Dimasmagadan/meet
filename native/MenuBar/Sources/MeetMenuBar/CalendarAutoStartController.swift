import AVFoundation
import Cocoa
import EventKit

// Auto-starts RecordingController from a calendar poll (SPEC_CALENDAR_AUTOSTART_2026-08-04).
// Pure decision logic (matching/cap/ranking) lives in CalendarMatch; this file is the
// EventKit/AppKit glue: fetch, permissions, sleep/wake, and the start dispatch.
final class CalendarAutoStartController: NSObject {
    private static let enabledKey = "calendarAutoRecordEnabled"
    private static let maxLatenessKey = "calendarAutoRecordMaxLatenessMinutes"
    private static let defaultMaxLatenessMinutes = 5
    // Widened past the ±5min live-detection window purely to see a back-to-back successor
    // for the cap-grace lookahead (§2.7) — costs nothing on a fetch that's already happening.
    private static let lookaheadMinutes = 90.0
    private static let backWindowMinutes = 15.0

    // Fires when calendar access is denied at enable time — caller flips the toggle back off
    // and should tell the user (mirrors PermissionController's fail-closed convention).
    var onCalendarPermissionDenied: (() -> Void)?
    // Fires when mic access is denied at enable time. Toggle stays ON (it starts working once
    // granted) — caller shows the same alert + Privacy pane the manual Start path shows.
    var onMicPermissionDenied: (() -> Void)?
    // Fires once per poll tick after nextEventSummary() may have changed, so the idle menu's
    // "Next: …" line (§2.8) can stay live without a dedicated UI timer.
    var onNextEventChanged: (() -> Void)?

    private let store = EKEventStore()
    private let recordingController: RecordingController
    private let permission: PermissionController
    private let fetchQueue = DispatchQueue(label: "com.dimasmagadan.meet.menubar.calendar-fetch")

    private var pollTimer: Timer?
    private var resolvedOccurrences = Set<String>()
    private var loggedMicSkips = Set<String>()
    private var cachedNextSummary: String?
    // Generation token for the enable cycle: disabling bumps it so any
    // already-queued fetch or in-flight permission Task from the previous
    // cycle is discarded at the next async boundary instead of restarting
    // polling or auto-starting after the toggle went off.
    private var pollGeneration = 0
    private var enableTask: Task<Void, Never>?

    init(recordingController: RecordingController, permission: PermissionController) {
        self.recordingController = recordingController
        self.permission = permission
        super.init()

        NotificationCenter.default.addObserver(self, selector: #selector(storeChanged), name: .EKEventStoreChanged, object: store)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(willSleep), name: NSWorkspace.willSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake), name: NSWorkspace.didWakeNotification, object: nil)

        if isEnabled, calendarAuthorized {
            startPolling()
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        pollTimer?.invalidate()
    }

    // MARK: - Toggle (§2.8)

    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
        // Invalidate any queued fetch or in-flight permission Task first: their
        // continuations recheck the generation before touching polling state.
        pollGeneration += 1
        enableTask?.cancel()
        enableTask = nil
        guard enabled else {
            stopPolling()
            cachedNextSummary = nil
            return
        }

        let generation = pollGeneration
        enableTask = Task { @MainActor in
            let calendarGranted = await self.requestCalendarAccess()
            guard !Task.isCancelled, generation == self.pollGeneration, self.isEnabled else { return }
            guard calendarGranted else {
                UserDefaults.standard.set(false, forKey: Self.enabledKey)
                self.onCalendarPermissionDenied?()
                return
            }

            let micGranted = await self.permission.ensureMic()
            guard !Task.isCancelled, generation == self.pollGeneration, self.isEnabled else { return }
            if !micGranted {
                self.onMicPermissionDenied?()
            }

            self.startPolling()
        }
    }

    func nextEventSummary() -> String? {
        guard isEnabled else { return nil }
        return cachedNextSummary
    }

    // MARK: - Permission (§2.5)

    private var calendarAuthorized: Bool {
        if #available(macOS 14.0, *) {
            return EKEventStore.authorizationStatus(for: .event) == .fullAccess
        } else {
            return EKEventStore.authorizationStatus(for: .event) == .authorized
        }
    }

    private func requestCalendarAccess() async -> Bool {
        if calendarAuthorized { return true }
        return await withCheckedContinuation { cont in
            if #available(macOS 14.0, *) {
                store.requestFullAccessToEvents { granted, _ in cont.resume(returning: granted) }
            } else {
                store.requestAccess(to: .event) { granted, _ in cont.resume(returning: granted) }
            }
        }
    }

    private var maxLatenessMinutes: Int {
        let stored = UserDefaults.standard.integer(forKey: Self.maxLatenessKey)
        return stored > 0 ? stored : Self.defaultMaxLatenessMinutes
    }

    // MARK: - Sleep / wake (§2.3)

    @objc private func willSleep(_ note: Notification) {
        stopPolling()
    }

    @objc private func didWake(_ note: Notification) {
        guard isEnabled, calendarAuthorized else { return }
        startPolling()
    }

    @objc private func storeChanged(_ note: Notification) {
        store.reset()
    }

    // MARK: - Poll loop (§2.2)

    private func startPolling() {
        guard pollTimer == nil, calendarAuthorized else { return }
        let timer = Timer(timeInterval: 20, repeats: true) { [weak self] _ in
            self?.tick()
        }
        timer.tolerance = 5
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        tick()
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func tick() {
        let generation = pollGeneration
        fetchQueue.async { [weak self] in
            guard let self else { return }
            let now = Date()
            let predicate = self.store.predicateForEvents(
                withStart: now.addingTimeInterval(-Self.backWindowMinutes * 60),
                end: now.addingTimeInterval(Self.lookaheadMinutes * 60),
                calendars: nil
            )
            let events = self.store.events(matching: predicate)
            DispatchQueue.main.async {
                guard generation == self.pollGeneration else { return }
                self.process(events: events, now: now)
            }
        }
    }

    // MARK: - Decision (steps 2-6)

    private func process(events: [EKEvent], now: Date) {
        guard isEnabled else { return }
        let qualifying = events.filter { qualifies($0) }
        updateNextEvent(qualifying: qualifying, now: now)

        // Step 4: drop already-resolved occurrences. Step 3: lateness gate.
        var liveByKey: [String: (event: EKEvent, candidate: Candidate)] = [:]
        for event in qualifying {
            guard let start = event.startDate, let end = event.endDate else { continue }
            guard CalendarMatch.isLive(now: now, start: start, end: end, maxLatenessMinutes: maxLatenessMinutes) else { continue }
            let occurrence = event.occurrenceDate ?? start
            let key = CalendarMatch.occurrenceKey(eventIdentifier: event.eventIdentifier, occurrenceDate: occurrence)
            guard !resolvedOccurrences.contains(key) else { continue }
            liveByKey[key] = (event, Candidate(key: key, title: resolvedTitle(event), start: start, end: end))
        }

        // Step 5: a busy controller drops every candidate silently, without resolving them —
        // they're re-evaluated next tick once it frees up.
        guard recordingController.currentDisplayState() == .idle else { return }
        guard !liveByKey.isEmpty else { return }

        // Step 6: rank ties, resolve the whole overlap set so losers never re-trigger.
        let ranked = CalendarMatch.rankCandidates(Array(liveByKey.values.map(\.candidate)), now: now)
        for candidate in ranked { resolvedOccurrences.insert(candidate.key) }

        guard let winner = ranked.first, let winnerEvent = liveByKey[winner.key]?.event else { return }
        startIfPermitted(event: winnerEvent, candidate: winner, qualifying: qualifying, now: now)
    }

    private func startIfPermitted(event: EKEvent, candidate: Candidate, qualifying: [EKEvent], now: Date) {
        // Rechecked immediately before starting: the toggle may have gone off
        // while the fetch was in flight, and process()'s own guard ran before
        // ranking — this is the last chance to honor the user's disable.
        guard isEnabled else { return }
        // Synchronous check only — never prompt from a timer callback (§2.5).
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            if loggedMicSkips.insert(candidate.key).inserted {
                NSLog("CalendarAutoStartController: mic not authorized, skipping \"\(candidate.title)\"")
            }
            return
        }

        let nextStart = CalendarMatch.nextStart(after: candidate.end, starts: qualifying.compactMap { $0.startDate })
        let cap = CalendarMatch.capMinutes(now: now, end: candidate.end, nextStart: nextStart)
        recordingController.start(title: candidate.title, maxDurationMinutes: cap, attendees: attendeeNames(for: event))
    }

    // §6.1 — non-self attendees as a candidate name list, folded into the whisper prompt
    // (§6.2, transcriber.ts) and persisted to speakers.json for `meet speakers suggest` (§6.3).
    private func attendeeNames(for event: EKEvent) -> [String] {
        event.attendees?
            .filter { !$0.isCurrentUser }
            .compactMap { $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") }
            ?? []
    }

    private func updateNextEvent(qualifying: [EKEvent], now: Date) {
        let next = qualifying
            .filter { ($0.startDate ?? .distantPast) > now }
            .min { ($0.startDate ?? .distantFuture) < ($1.startDate ?? .distantFuture) }

        guard let next, let start = next.startDate else {
            cachedNextSummary = nil
            onNextEventChanged?()
            return
        }
        let minutes = max(0, Int(ceil(start.timeIntervalSince(now) / 60)))
        cachedNextSummary = "\(resolvedTitle(next)) — in \(minutes)m"
        onNextEventChanged?()
    }

    // MARK: - Matching (§2.1)

    private func qualifies(_ event: EKEvent) -> Bool {
        guard !event.isAllDay else { return false }
        guard event.status != .canceled else { return false }
        guard event.availability != .free else { return false }
        if let type = event.calendar?.type, type == .birthday || type == .subscription { return false }
        guard CalendarMatch.hasCallLink([event.location, event.notes, event.url?.absoluteString]) else { return false }
        guard event.attendees?.contains(where: { $0.isCurrentUser && $0.participantStatus == .declined }) != true else { return false }
        return true
    }

    private func resolvedTitle(_ event: EKEvent) -> String {
        let title = event.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? "meeting" : title
    }
}
