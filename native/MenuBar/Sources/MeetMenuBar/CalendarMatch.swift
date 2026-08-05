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

enum CalendarMatch {
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

    // §2.7 — remaining time to the event's end, plus a grace window trimmed when another
    // qualifying event starts soon after (back-to-back meetings), clamped to [0, 8] minutes.
    // Never returns 0 — recorder.ts treats --max-duration 0 as "no cap".
    static func capMinutes(now: Date, end: Date, nextStart: Date?) -> Int {
        let remaining = Int(ceil(end.timeIntervalSince(now) / 60))
        let grace: Int
        if let nextStart {
            let gapMinutes = Int(floor(nextStart.timeIntervalSince(end) / 60)) - 1
            grace = min(max(gapMinutes, 0), 8)
        } else {
            grace = 8
        }
        return max(1, remaining + grace)
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

    static func selfCheck() {
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

        // Lateness gate
        let start = Date(timeIntervalSince1970: 3_000_000)
        let end = start.addingTimeInterval(3600)
        assert(isLive(now: start.addingTimeInterval(4 * 60), start: start, end: end, maxLatenessMinutes: 5), "4 min late passes")
        assert(!isLive(now: start.addingTimeInterval(6 * 60), start: start, end: end, maxLatenessMinutes: 5), "6 min late fails")
        assert(!isLive(now: start.addingTimeInterval(-60), start: start, end: end, maxLatenessMinutes: 5), "not yet started fails")

        // Occurrence key
        let occ1 = Date(timeIntervalSince1970: 4_000_000)
        let occ2 = occ1.addingTimeInterval(86400)
        assert(occurrenceKey(eventIdentifier: "recurring-1", occurrenceDate: occ1) != occurrenceKey(eventIdentifier: "recurring-1", occurrenceDate: occ2), "two occurrences of one recurring event produce different keys")

        print("CalendarMatch.selfCheck: OK")
    }
}
