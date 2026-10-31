import Foundation

// Pure matching/cap/ranking logic for calendar auto-start (SPEC_CALENDAR_AUTOSTART_2026-08-04).
// No EventKit/AppKit imports on purpose — CalendarAutoStartController turns EKEvents into
// Candidates and calls in here; this file stays directly unit-testable via selfCheck().
struct Candidate: Equatable {
    let key: String
    let title: String
    let start: Date
    let end: Date
}

// P3 row 18 (SPEC_SAFETY_NET_2026-10-31 §7): attendee name selection, pure so
// the self-test can cover declined/room filtering and the "Doe, John" shape
// without EventKit. The controller maps EKParticipant → AttendeeDescriptor.
struct AttendeeDescriptor: Equatable {
    let isCurrentUser: Bool
    let isDeclined: Bool
    // Rooms/resources surface as .nonParticipant in EventKit — they are not
    // people and never registry candidates.
    let isNonParticipant: Bool
    let name: String?
    let mailto: String?
}

enum CalendarMatch {
    static let maxGraceMinutes = 8
    static let hardCapMultiplier = 2
    static let callLinkSubstrings = [
        "zoom.us", "zoomgov.com", "meet.google.com", "teams.microsoft.com", "teams.live.com",
        "webex.com", "whereby.com", "meet.jit.si", "telemost.yandex.ru", "jazz.sber.ru", "talk.kontur.ru",
    ]

    // §2.1 — case-insensitive substring match over location/notes/url. notes may carry HTML
    // from Google/Exchange sync; substring matching is immune to that, so no HTML/URL parsing.
    static func hasCallLink(_ haystacks: [String?]) -> Bool {
        let combined = haystacks.compactMap { $0 }.joined(separator: " ").lowercased()
        guard !combined.isEmpty else { return false }
        return callLinkSubstrings.contains { combined.contains($0) }
    }

    // §2.2 step 3 — keep only events where now is within [start, end) and not more than
    // maxLatenessMinutes past start.
    static func isLive(now: Date, start: Date, end: Date, maxLatenessMinutes: Int) -> Bool {
        guard now >= start, now < end else { return false }
        let latenessMinutes = now.timeIntervalSince(start) / 60
        return latenessMinutes <= Double(maxLatenessMinutes)
    }

    // §2.2 — occurrence key. Every occurrence of a recurring EKEvent shares one
    // eventIdentifier; keying on identifier + occurrence start makes dedup per-occurrence
    // instead of per-series.
    static func occurrenceKey(eventIdentifier: String?, occurrenceDate: Date) -> String {
        "\(eventIdentifier ?? "")|\(Int(occurrenceDate.timeIntervalSince1970))"
    }

    // §2.7 — successor selection for the cap-grace lookahead: the earliest
    // qualifying start at or after this event's end. Equality is included on
    // purpose — a back-to-back call starting exactly when this one ends still
    // needs its own auto-start, and dropping it over-records past the next
    // call's lateness allowance.
    static func nextStart(after end: Date, starts: [Date]) -> Date? {
        starts.filter { $0 >= end }.min()
    }

    // §2.7 — remaining time to the event's end, plus a grace window trimmed when another
    // qualifying event starts soon after (back-to-back meetings), clamped to [0, 8] minutes.
    // Never returns 0 — recorder.ts treats --max-duration 0 as "no cap".
    static func capMinutes(now: Date, end: Date, nextStart: Date?) -> Int {
        let remaining = Int(ceil(end.timeIntervalSince(now) / 60))
        let grace: Int
        if let nextStart {
            let gapMinutes = Int(floor(nextStart.timeIntervalSince(end) / 60)) - 1
            grace = min(max(gapMinutes, 0), maxGraceMinutes)
        } else {
            grace = maxGraceMinutes
        }
        return max(1, remaining + grace)
    }

    static func extensionNextStart(winnerKey: String, now: Date, candidates: [Candidate], resolvedKeys: Set<String>) -> Date? {
        candidates.filter { $0.key != winnerKey && !resolvedKeys.contains($0.key) && $0.start > now }
            .map(\.start).min()
    }

    static func hardCapMinutes(scheduledMinutes: Int, softCapMinutes: Int, minutesUntilNextStart: Int?, horizonMinutes: Int) -> Int? {
        var ceiling = scheduledMinutes * hardCapMultiplier
        if let minutesUntilNextStart { ceiling = min(ceiling, minutesUntilNextStart - 1) }
        ceiling = min(ceiling, horizonMinutes)
        return ceiling > softCapMinutes ? ceiling : nil
    }

    // §2.4 — deterministic overlap resolution: latest start first, then shortest duration,
    // then title. No UI, no alert — see spec for the reasoning (a blocking alert defeats the
    // point of an away-from-keyboard auto-start).
    static func rankCandidates(_ candidates: [Candidate], now: Date) -> [Candidate] {
        candidates.sorted { a, b in
            if a.start != b.start { return a.start > b.start }
            let durationA = a.end.timeIntervalSince(a.start)
            let durationB = b.end.timeIntervalSince(b.start)
            if durationA != durationB { return durationA < durationB }
            return a.title < b.title
        }
    }

    // MARK: - Self-check (see §5) — run via `MeetMenuBar --self-test-calendar`.

    // P3 row 18: non-self attendees as candidate names — declined invitees and
    // rooms/resources excluded, names kept whole (no comma re-split: "Doe, John"
    // is one person's display name).
    static func candidateAttendeeNames(_ attendees: [AttendeeDescriptor]) -> [String] {
        attendees
            .filter { !$0.isCurrentUser && !$0.isDeclined && !$0.isNonParticipant }
            .compactMap { $0.name ?? $0.mailto?.replacingOccurrences(of: "mailto:", with: "") }
            .filter { !$0.isEmpty }
    }

    static func selfCheck() {
        // candidateAttendeeNames (P3 row 18)
        let attendeeFixtures: [AttendeeDescriptor] = [
            AttendeeDescriptor(isCurrentUser: true, isDeclined: false, isNonParticipant: false, name: "Me Myself", mailto: nil),
            AttendeeDescriptor(isCurrentUser: false, isDeclined: false, isNonParticipant: false, name: "Doe, John", mailto: nil),
            AttendeeDescriptor(isCurrentUser: false, isDeclined: true, isNonParticipant: false, name: "Declined Dan", mailto: nil),
            AttendeeDescriptor(isCurrentUser: false, isDeclined: false, isNonParticipant: true, name: "Meeting Room 4", mailto: nil),
            AttendeeDescriptor(isCurrentUser: false, isDeclined: false, isNonParticipant: false, name: nil, mailto: "mailto:alias@corp.example"),
        ]
        let names = candidateAttendeeNames(attendeeFixtures)
        assert(names == ["Doe, John", "alias@corp.example"], "declined/room/self filtered, comma name whole, mailto stripped: \(names)")
        assert(candidateAttendeeNames([]).isEmpty, "no attendees → empty list")

        // hasCallLink
        // hasCallLink
        assert(hasCallLink(["https://zoom.us/j/123", nil, nil]), "location hit")
        assert(hasCallLink([nil, "Join: <a href='https://meet.google.com/abc-defg'>link</a>", nil]), "HTML-wrapped notes hit")
        assert(hasCallLink(["ZOOM.US/j/123", nil, nil]), "case-insensitive")
        assert(hasCallLink([nil, nil, "https://company.zoom.us/j/999"]), "subdomain")
        assert(!hasCallLink(["Weekly sync agenda", "Discuss roadmap, no call today", nil]), "plain agenda, no link")
        assert(!hasCallLink([nil, nil, nil]), "all nil")

        // capMinutes
        let now = Date(timeIntervalSince1970: 1_000_000)
        let end5 = now.addingTimeInterval(5 * 60)
        assert(capMinutes(now: now, end: end5, nextStart: nil) == 5 + 8, "no next event: flat +8 grace")
        let nextFar = end5.addingTimeInterval(30 * 60)
        assert(capMinutes(now: now, end: end5, nextStart: nextFar) == 5 + 8, "next event far away: grace clamped at 8")
        let next3After = end5.addingTimeInterval(3 * 60)
        assert(capMinutes(now: now, end: end5, nextStart: next3After) == 5 + 2, "next event 3 min after end: grace trimmed to 2")
        assert(capMinutes(now: now, end: end5, nextStart: end5) == 5 + 0, "next event immediately after end: grace 0")
        let pastEnd = now.addingTimeInterval(-10 * 60)
        assert(capMinutes(now: now, end: pastEnd, nextStart: pastEnd) == 1, "never returns 0")
        assert(hardCapMinutes(scheduledMinutes: 30, softCapMinutes: 38, minutesUntilNextStart: nil, horizonMinutes: 240) == 60)
        assert(hardCapMinutes(scheduledMinutes: 45, softCapMinutes: 53, minutesUntilNextStart: nil, horizonMinutes: 240) == 90)
        assert(hardCapMinutes(scheduledMinutes: 3, softCapMinutes: 11, minutesUntilNextStart: nil, horizonMinutes: 240) == nil)
        assert(hardCapMinutes(scheduledMinutes: 8, softCapMinutes: 16, minutesUntilNextStart: nil, horizonMinutes: 240) == nil)
        assert(hardCapMinutes(scheduledMinutes: 10, softCapMinutes: 18, minutesUntilNextStart: nil, horizonMinutes: 240) == 20)
        assert(hardCapMinutes(scheduledMinutes: 60, softCapMinutes: 68, minutesUntilNextStart: 105, horizonMinutes: 240) == 104)
        assert(hardCapMinutes(scheduledMinutes: 30, softCapMinutes: 38, minutesUntilNextStart: 38, horizonMinutes: 240) == nil)
        assert(hardCapMinutes(scheduledMinutes: 180, softCapMinutes: 188, minutesUntilNextStart: nil, horizonMinutes: 240) == 240)
        let fractionalNext = now.addingTimeInterval(105 * 60 + 30)
        let fractionalBudget = Int(floor(fractionalNext.timeIntervalSince(now) / 60))
        assert(hardCapMinutes(scheduledMinutes: 60, softCapMinutes: 68, minutesUntilNextStart: fractionalBudget, horizonMinutes: 240) == 104)
        let fractionalScheduled = Int(ceil((30 * 60 + 1) / 60.0))
        assert(hardCapMinutes(scheduledMinutes: fractionalScheduled, softCapMinutes: 39, minutesUntilNextStart: nil, horizonMinutes: 240) == 62)

        // rankCandidates
        let now2 = Date(timeIntervalSince1970: 2_000_000)
        assert(rankCandidates([], now: now2).isEmpty, "0 candidates")
        let solo = Candidate(key: "a", title: "A", start: now2, end: now2.addingTimeInterval(1800))
        assert(rankCandidates([solo], now: now2) == [solo], "1 candidate")
        let earlier = Candidate(key: "b", title: "Earlier", start: now2.addingTimeInterval(-600), end: now2.addingTimeInterval(1800))
        let later = Candidate(key: "c", title: "Later", start: now2, end: now2.addingTimeInterval(1800))
        assert(rankCandidates([earlier, later], now: now2).first?.key == "c", "later start wins")
        let long = Candidate(key: "d", title: "Long", start: now2, end: now2.addingTimeInterval(3600))
        let short = Candidate(key: "e", title: "Short", start: now2, end: now2.addingTimeInterval(900))
        assert(rankCandidates([long, short], now: now2).first?.key == "e", "equal start: shorter duration wins")
        let zeta = Candidate(key: "f", title: "Zeta", start: now2, end: now2.addingTimeInterval(900))
        let alpha = Candidate(key: "g", title: "Alpha", start: now2, end: now2.addingTimeInterval(900))
        assert(rankCandidates([zeta, alpha], now: now2).first?.key == "g", "identical span: lexicographic title")
        let winner = Candidate(key: "winner", title: "Winner", start: now2, end: now2.addingTimeInterval(3600))
        let overlap = Candidate(key: "overlap", title: "Overlap", start: now2.addingTimeInterval(3000), end: now2.addingTimeInterval(4800))
        assert(extensionNextStart(winnerKey: winner.key, now: now2, candidates: [winner, overlap], resolvedKeys: []) == overlap.start)
        assert(extensionNextStart(winnerKey: winner.key, now: now2, candidates: [winner, overlap], resolvedKeys: [overlap.key]) == nil)

        // Lateness gate
        let start = Date(timeIntervalSince1970: 3_000_000)
        let end = start.addingTimeInterval(3600)
        assert(isLive(now: start.addingTimeInterval(4 * 60), start: start, end: end, maxLatenessMinutes: 5), "4 min late passes")
        assert(!isLive(now: start.addingTimeInterval(6 * 60), start: start, end: end, maxLatenessMinutes: 5), "6 min late fails")
        assert(!isLive(now: start.addingTimeInterval(-60), start: start, end: end, maxLatenessMinutes: 5), "not yet started fails")

        // nextStart successor selection + cap calculation (integration: the
        // controller feeds qualifying starts through nextStart into capMinutes)
        let wEnd = Date(timeIntervalSince1970: 5_000_000)
        let wNow = wEnd.addingTimeInterval(-5 * 60)
        assert(nextStart(after: wEnd, starts: []) == nil, "no starts: no successor")
        assert(nextStart(after: wEnd, starts: [wEnd.addingTimeInterval(-60)]) == nil, "earlier start is not a successor")
        let exactSucc = nextStart(after: wEnd, starts: [wEnd.addingTimeInterval(600), wEnd])
        assert(exactSucc == wEnd, "exact back-to-back start is a successor")
        assert(capMinutes(now: wNow, end: wEnd, nextStart: exactSucc) == 5, "back-to-back successor trims grace to 0, cap is exactly the remaining time")
        let soonSucc = nextStart(after: wEnd, starts: [wEnd.addingTimeInterval(600), wEnd.addingTimeInterval(60)])
        assert(soonSucc == wEnd.addingTimeInterval(60), "earliest successor wins")
        assert(capMinutes(now: wNow, end: wEnd, nextStart: soonSucc) == 5, "1 min gap: grace trimmed to 0")

        // Occurrence key
        let occ1 = Date(timeIntervalSince1970: 4_000_000)
        let occ2 = occ1.addingTimeInterval(86400)
        assert(occurrenceKey(eventIdentifier: "recurring-1", occurrenceDate: occ1) != occurrenceKey(eventIdentifier: "recurring-1", occurrenceDate: occ2), "two occurrences of one recurring event produce different keys")

        print("CalendarMatch.selfCheck: OK")
    }
}
