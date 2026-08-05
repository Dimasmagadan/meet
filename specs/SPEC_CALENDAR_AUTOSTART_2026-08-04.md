# SPEC: Calendar Auto-Start

**Date:** 2026-08-04 (reviewed 2026-08-05)
**Status:** Draft — pre-implementation
**Owner:** Dmitrii Diakonov

Review pass on 2026-08-05 changed three locked decisions (§2.2 lateness gate, §2.4 overlap
resolution, §2.7 back-to-back grace) and fixed one outright bug in the original design
(recurring-event dedupe, §2.2). Each is marked **[review]** with the reason, so the original
decisions can be restored deliberately rather than by accident.

---

## 1. Overview

Auto-start recording when a calendar event with a video-call link begins, so meetings aren't
missed or started late. Builds on the existing `native/MenuBar/` app (`Meet.app`) — reuses
`RecordingController` exactly as the manual Start does, just triggers it from a calendar poll
instead of a menu click.

Decisions locked in from discussion:
- **Trigger filter**: event must carry a recognizable video-call link (Zoom/Meet/Teams/Webex/
  Whereby/Telemost/Jazz/Kontur) in its location, notes, or URL field. Plain calendar blocks
  without a link never auto-record.
- **Confirmation**: none. Starts silently — the existing menubar icon state change and the
  notch panel are the only signals.
- **Start timing**: at the event's start time (0 min lead), detected within one poll tick.
- **Auto-stop cap**: `remaining-scheduled-minutes + grace`, via the existing
  `maxDurationMinutes` mechanism (`recorder.ts`) and the CLI's `--max-duration` flag. Extend
  (+15m, `SIGWINCH` → `extendCap()`) keeps working unmodified — it adds to whatever cap is set.
- **Sleep**: the poll only runs while the Mac is awake. No wake-scheduling, no sleep-time
  backfill — asleep means the controller does nothing, full stop (§2.3).

### Non-goals (v1)
- No calendar allow-list / deny-list UI — the link filter plus the cheap exclusions in §2.1 do
  the job asked for; add a picker only if that proves too broad in practice.
- No queueing: a candidate that appears while `RecordingController` is not idle is skipped
  outright, no alert, no queue — a single-pipeline recorder can't run two sessions, and
  switching mid-call would kill the one in progress.
- No joining the call itself (Zoom/Meet app launch) — audio-only local recording, as today.
- No mic-in-use meeting detection for unscheduled calls (see §7.2 — this is the highest-value
  follow-up, but it is a separate feature with a separate trigger source).

---

## 2. Behavior

### 2.1 Matching

An `EKEvent` qualifies when a case-insensitive search of `location`, `notes`, and
`url?.absoluteString` hits one of:

```
zoom.us  zoomgov.com  meet.google.com  teams.microsoft.com  teams.live.com
webex.com  whereby.com  meet.jit.si  telemost.yandex.ru  jazz.sber.ru  talk.kontur.ru
```

Plain substring matching on a lowercased haystack — no regex needed, and it makes the list
trivially extendable. Hardcoded inline; add a config file only if editing the list becomes a
habit. `notes` may contain HTML from Google/Exchange sync — substring matching is immune to
that, another reason not to reach for a URL parser.

Skipped (all one-liners, all worth having):

| Condition | Why |
|---|---|
| `event.isAllDay` | never a call |
| `event.status == .canceled` | already in original spec |
| `event.availability == .free` | **[review]** OOO / Focus Time / "Working Location" blocks pasted with an old link. Granola excludes exactly these |
| `event.calendar.type == .birthday \|\| .subscription` | read-only noise calendars |
| current user declined | **[review]** — see below |

**Declined events** — the original non-goal said detecting "I declined" means walking
`event.attendees` for the current user and isn't worth it. It's four lines, EventKit does the
identity match for us, and we need the attendee list anyway for §6:

```swift
event.attendees?.contains { $0.isCurrentUser && $0.participantStatus == .declined } == true
```

Declining is the single strongest "I am not in this call" signal available. Keep it.

### 2.2 Poll loop

`CalendarAutoStartController` runs a repeating `Timer` (20s, `tolerance = 5`, added to
`RunLoop.main` in `.common` mode so an open menubar menu doesn't starve it) while the toggle is
on **and** the Mac is awake (§2.3).

Each tick:

1. Fetch events via `EKEventStore.events(matching: predicateForEvents(withStart: now - 15min,
   end: now + 5min, calendars: nil))`.
   - **The predicate returns every event that _overlaps_ the window, not every event that
     _starts_ in it.** The original spec's "±5 min slop covers opening the laptop 3 minutes
     late" rationale was wrong: a 60-minute event that started 40 minutes ago also overlaps a
     ±5 min window and would be returned. Lateness is therefore gated explicitly in step 3,
     not implied by the window width. The window only needs to be wide enough to see events
     that started at most `maxLateness` ago — hence `now - 15min`.
   - Run the fetch on one dedicated serial `DispatchQueue` (`EKEventStore` fetches are
     synchronous and can take hundreds of ms with several subscribed calendars; doing that on
     the main thread every 20s hitches the UI). Hop back to main for the decision and the
     `RecordingController` call.
2. Filter to qualifying events (§2.1).
3. **[review] Lateness gate**: keep only events where `now ∈ [startDate, endDate)` **and**
   `now - startDate <= maxLatenessMinutes` (default 5, `UserDefaults` key
   `calendarAutoRecordMaxLatenessMinutes`). Without this, waking the Mac at minute 55 of a
   60-minute meeting silently starts a 5-minute recording of the goodbyes — the worst kind of
   surprise for a feature with no confirmation step.
4. Drop events whose **occurrence key** is already resolved this run (see below).
5. If `RecordingController` is not idle → drop all candidates silently. Note the controller's
   `state` is `private`; use the existing `currentDisplayState()` accessor rather than widening
   it.
6. By candidate count: **0** → nothing. **1** → start it (§2.6). **2+** → §2.4.

**Occurrence key — this was a real bug.** The original design deduped on
`event.eventIdentifier`. On macOS, *every occurrence of a recurring event shares one
`eventIdentifier`*, so a daily standup would auto-record exactly once and then never again for
the lifetime of the app process. Key the resolved set on:

```swift
"\(event.eventIdentifier ?? "")|\(Int((event.occurrenceDate ?? event.startDate).timeIntervalSince1970))"
```

The set stays in-memory / process-lifetime only, as originally specced — with the correct key
that's now genuinely safe, since a restart at worst re-evaluates the currently-live occurrence,
which the idle check drops anyway.

**Store staleness**: `EKEventStore` caches. An event created or edited externally (phone,
web Google Calendar) can be invisible to `events(matching:)` until the store is refreshed.
Observe `.EKEventStoreChanged` and call `store.reset()` on it — two lines, and without them the
first manual test ("I just made a test event and nothing happened") looks like a broken feature.

### 2.3 Sleep gating

- Observe `NSWorkspace.shared.notificationCenter` for `willSleepNotification` (invalidate the
  timer) and `didWakeNotification` (recreate it, and fire one tick immediately). A `Timer`
  already doesn't fire while asleep; the explicit observers make "does nothing while asleep" a
  stated invariant rather than an accident of `RunLoop` semantics, and avoid a catch-up burst at
  wake.
- No `pmset schedule wake` / `IOPMSchedulePowerEvent`. If the Mac is asleep when a meeting
  starts, that meeting is not auto-recorded. On wake, the next tick evaluates what's live now —
  and with §2.2's lateness gate, an event that started more than 5 minutes ago stays untouched.

### 2.4 Overlap resolution — **[review] changed**

**Original design**: blocking `NSAlert` listing each candidate + "Don't Record".

**Problem**: the modal blocks the main run loop until answered. The scenario auto-start exists
for is "I'm not at the keyboard when the call starts" — and in exactly that scenario the alert
sits unanswered and **nothing gets recorded at all**, while also stalling the 2s
`SessionMonitor` attach timer. A feature whose failure mode is "records nothing, silently, and
freezes a background monitor" is worse than one that occasionally picks the wrong of two
simultaneous calls.

**New design**: pick deterministically, no UI.

```
sort candidates by: (1) latest startDate first  — the call that is actually just beginning
                    (2) shortest duration        — the specific slot beats the all-hands block
                    (3) title, lexicographic     — stable tie-break, testable
```

Start the first one. Mark **all** candidates in the overlap set resolved, so the losers don't
re-trigger on the next tick. If the pick is wrong the user sees it within seconds (menubar
icon + notch panel + the title in the menu) and has "Rename Meeting…" and Stop.

Cost: one wrong pick occasionally. Benefit: deletes the entire alert flow, the
`NSApp.activate` dance, and the away-from-keyboard dead end. Ranking rule (1) is right far
more often than not — two live candidates almost always means a long block (sprint, "focus")
overlapping the real 30-minute call that just started.

*If you want the alert back*: keep it, but give it a 30-second timeout that falls through to
this same deterministic pick. Never let it block indefinitely.

### 2.5 Permission

Two prompts are involved and both must be handled, or auto-start fails silently at the worst
moment.

**Calendar** — the app targets macOS 13 (`LSMinimumSystemVersion`, `platforms: [.macOS(.v13)]`),
so the API is version-split:

```swift
if #available(macOS 14.0, *) { store.requestFullAccessToEvents { granted, _ in … } }
else { store.requestAccess(to: .event) { granted, _ in … } }
```

`requestAccess(to:)` is deprecated on 14+ and pairs with the wrong usage-description key.
Status check likewise: `.fullAccess` on 14+, `.authorized` below. Denied → toggle flips back
off, no repeated prompting (same fail-open-to-inactive convention as `PermissionController`).

**Microphone** — **[review] missing from the original spec.** `AppDelegate.startRecording()`
gates on `await permission.ensureMic()` before spawning; the auto path must not skip that or a
denied mic produces a spawn that dies and fires `onCaptureFailed` mid-meeting. But the auto path
can't `await` a prompt that nobody is there to answer. Split it:

- **At toggle-enable time** (the user is present): run `permission.ensureMic()`; if denied, show
  the same alert + `openPrivacySettings(.microphone)` the manual path shows, and leave the toggle
  on — it'll work once granted.
- **At auto-start time**: check `AVCaptureDevice.authorizationStatus(for: .audio) == .authorized`
  synchronously. Not authorized → skip the candidate, mark it resolved, log once. Never prompt
  from a timer callback.

System audio has no preflight (Core Audio process tap, see `PermissionController`'s note);
failures still surface via the existing `onCaptureFailed` path.

### 2.6 Starting

```swift
recordingController.start(title: event.title ?? "meeting", maxDurationMinutes: cap, attendees: names)
```

- **Title**: `event.title`. No sanitization needed — `storage.ts:generateSlug()` already handles
  the folder name. Empty/nil → `"meeting"`, matching the manual path's default.
- **No naming prompt.** The manual path shows one after starting; the auto path must not — a
  modal `NSAlert` popping up mid-call is exactly the "silent start" promise being broken.
  "Rename Meeting…" remains available.
- **Cap** (§2.7).
- **Attendees** (§6) — phase 2, the parameter is listed here so the signature is designed once.

### 2.7 Cap arithmetic and back-to-back meetings — **[review]**

```
remaining = ceil((endDate - now) / 60)
grace     = nextQualifyingStart == nil ? 8
                                       : clamp(floor((nextQualifyingStart - endDate)/60) - 1, 0, 8)
minutes   = max(1, remaining + grace)
```

Two things the original formula missed:

1. **`--max-duration 0` means "no cap"** (`recorder.ts:486`). The formula must never be able to
   emit 0 — hence the `max(1, …)`. Today `now < endDate` guarantees `remaining >= 1`, but a
   future edit to the candidate predicate shouldn't be able to silently disable the auto-stop.
2. **Back-to-back meetings were structurally unrecordable.** 10:00–11:00 followed by 11:00–12:00:
   the first recording runs to 11:08 by the flat +8 grace, so the second event is already 8
   minutes late when the recorder frees up — past the 5-minute lateness gate, skipped forever.
   Trimming the grace when the calendar shows another qualifying event starting sooner fixes it
   with arithmetic instead of a queue.

`nextQualifyingStart` is the earliest `startDate > endDate` among qualifying events already in
the fetched window; nil if none (the window reaches `now + 5min`, which is enough to see a
back-to-back successor only near the end of a call — widen the forward edge to `now + 90min`
purely to feed this lookahead, it costs nothing on a fetch that's already happening).

**Also pass `--no-text-timeout`** (config default) on auto-started sessions. A calendar-driven
start has no human watching it; the existing no-text auto-stop is what ends a meeting that
finished 40 minutes early, and it's the same signal Granola uses (their "15 audio-free minutes
→ stop"). Pure reuse of a flag that already exists.

**Known limitation, accepted**: the recorder clears `active-recording.lock` when capture stops
and *then* runs finalization in-process (`recorder.ts:239`, before `finalizeSession`). So the
menubar returns to idle before finalize completes, and a back-to-back auto-start will run its
live pipeline concurrently with the previous meeting's final pass. `acquireGlobalFinalPassLock`
already serializes the heavy passes and `applyQoS` already de-prioritizes them, so this
degrades to slower finalization, not corruption. Worth a line in the release note.

### 2.8 Toggle and visibility

New checkable menu item **"Auto-Record Calendar Calls"**, persisted in `UserDefaults`
(`calendarAutoRecordEnabled`, default `false` — opt-in), same pattern as
`LoginItemController`'s checkbox. Enabling requests Calendar access and runs the mic check
(§2.5); disabling invalidates the timer.

**[review] Add one more line to the idle menu**: the next qualifying event, e.g.
`Next: Weekly sync — in 12m` (disabled item, `nil` action). The controller has already fetched
the events; this is ~5 lines and it's the only thing that makes a silent, confirmation-free
feature observable — "is this thing armed and does it see my calendar?" is otherwise
unanswerable without Console.app. Granola, Otter and every menubar calendar app show this for
the same reason.

---

## 3. Architecture (`native/MenuBar/`)

1. **`CalendarAutoStartController.swift`** (new) — owns the `EKEventStore`, the fetch queue, the
   poll `Timer`, the resolved-occurrence `Set<String>`, the `NSWorkspace` sleep/wake and
   `.EKEventStoreChanged` observers, and the enable/disable + permission entry points. Calls
   `RecordingController.start(title:maxDurationMinutes:attendees:)`. Exposes `nextEventSummary()`
   for the menu line (§2.8).
2. **`CalendarMatch.swift`** (new, pure) — no EventKit or AppKit imports, so it's directly
   testable: `hasCallLink(_:) -> Bool`, `capMinutes(now:end:nextStart:) -> Int`,
   `rankCandidates([Candidate], now:) -> [Candidate]` over a plain
   `struct Candidate { key, title, start, end }`. The controller's job is reduced to turning
   `EKEvent`s into `Candidate`s.
3. **`RecordingController.swift`** — `start(title:)` gains optional params:
   `start(title: String, maxDurationMinutes: Int? = nil, attendees: [String] = [])`. Appends
   `["--max-duration", "\(m)"]` and (phase 2) `["--attendees", names.joined(separator: ",")]`.
   Manual Start keeps calling it with defaults → `config.maxDurationMinutes`, unchanged.
4. **`AppDelegate.swift`** — instantiate the controller, add the checkable menu item + `@objc`
   toggle (mirrors `addLoginItem(to:)`), add the "Next:" line to the idle menu.
5. **`main.swift`** — extend the existing self-test dispatch (`--self-test-notch` precedent) with
   `--self-test-calendar` → `CalendarMatch.selfCheck()`.
6. **`Info.plist`** — `NSCalendarsUsageDescription` **and** `NSCalendarsFullAccessUsageDescription`
   (macOS 14+ wording). Both, since the app supports 13.
7. **`Package.swift`** — add `.linkedFramework("EventKit")` next to `ServiceManagement`. The
   original spec asserted autolinking makes this unnecessary; it usually does, but the one-line
   insurance is cheaper than debugging a release-build link error, and it matches the file's
   existing convention.

**TCC note**: `scripts/build.sh` signs with the stable "Meet Self-Signed" identity when present.
Calendar access is a TCC grant like mic — on machines falling back to ad-hoc signing, expect a
re-prompt each rebuild (same known behavior as `SPEC_TCC_SIGNING_2026-07-31`).

No Node/TypeScript changes for phase 1 — `--max-duration` and `--no-text-timeout` already exist.

---

## 4. Files touched

| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/CalendarAutoStartController.swift` | **new** — EventKit poll, permissions, sleep/wake, start dispatch |
| `native/MenuBar/Sources/MeetMenuBar/CalendarMatch.swift` | **new** — pure matching / cap / ranking + `selfCheck()` |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | `start()` gains `maxDurationMinutes` (+ `attendees` in phase 2) |
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | instantiate controller, checkable menu item, "Next:" line |
| `native/MenuBar/Sources/MeetMenuBar/main.swift` | `--self-test-calendar` dispatch |
| `native/MenuBar/Info.plist` | both calendar usage-description keys |
| `native/MenuBar/Package.swift` | `.linkedFramework("EventKit")` |

---

## 5. Testing

**Automated** — `CalendarMatch.selfCheck()`, assert-based, run via
`.build/release/MeetMenuBar --self-test-calendar` (same shape as `--self-test-notch`):

- `hasCallLink` — hit in location / notes / url; case-insensitivity; HTML-wrapped notes;
  `company.zoom.us` subdomain; a plain agenda with no link → false.
- `capMinutes` — mid-event remaining + 8; no next event; next event 3 min after end → grace
  trimmed to 2; next event immediately after end → grace 0; never returns 0.
- `rankCandidates` — 0/1/2 candidates; later start wins; equal starts → shorter duration wins;
  identical span → lexicographic title (deterministic, not input-order dependent).
- Lateness gate — event started 4 min ago passes, 6 min ago doesn't, not-yet-started doesn't.
- Occurrence key — two occurrences of one recurring event produce different keys. *(This is the
  regression test for the bug the review found; don't skip it.)*

**Manual** (no headless way to drive EventKit or real sleep/wake):

- First enable → calendar prompt; deny → toggle flips back off.
- Mic denied at enable time → alert + Privacy pane opens, toggle stays on.
- Test event 2 min out with a Zoom link in the location → starts within one tick of its start
  time, title matches, icon shows `.recording`, no naming dialog appears.
- Same event, no link → nothing. Same event marked "Free" → nothing. Declined → nothing.
- **Recurring** daily event with a link → fires on day 1 *and* day 2 without restarting the app.
- Create a qualifying event externally (phone) starting in 1 min → fires (proves the
  `.EKEventStoreChanged` → `reset()` path).
- Sleep before the start, wake 20 min in → does **not** start (lateness gate). Wake 2 min in →
  starts.
- Sleep with the toggle on → log confirms the timer is invalidated on `willSleepNotification`
  and recreated on `didWakeNotification`.
- Two overlapping qualifying events → the later-starting/shorter one records, no dialog, the
  other never re-triggers.
- Second qualifying event while recording → skipped silently.
- Back-to-back 10:00–11:00 / 11:00–12:00 → first caps at ~11:00 (grace trimmed), second
  auto-starts within the lateness window.
- "Extend +15m" during an auto-started recording → cap increases as today.
- Cap reached with no extend → finalizes exactly like a manual max-duration stop.

---

## 6. Phase 2 — calendar participants → speaker names

This is the second question from the review, and it lands on ground the repo has already
prepared: `speaker-registry.ts` stores per-voice embeddings with names across meetings, and
`speaker-rename.ts` already propagates a rename into that registry so future meetings
auto-label the voice. What's missing is a *candidate name list* — and the calendar has one.

**What is and isn't possible.** Nothing in the audio lets us know that Speaker 2 *is* Anna.
Bot-based products (Recall.ai, Nylas) get real names because the conferencing platform emits
per-participant active-speaker events; we capture one mixed system-audio stream, so that door is
closed. What the attendee list can do is turn an open-ended "type a name" into a short pick
list, and — more valuably — make the names appear correctly in the transcript in the first place.

### 6.1 Capture the attendees (small, do it with phase 1's plumbing)

```swift
event.attendees?
  .filter { !$0.isCurrentUser }
  .compactMap { $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") }
```

→ `meet start … --attendees "Anna Petrova,Ivan S."`

- `cli.ts` — one `.option("--attendees <names>", …)`, comma-split.
- `types.ts` — `attendees?: string[]` on `Session`, exactly like the existing optional
  `tags?` / `gitContext?` fields.
- `finalize.ts` — copy it into `speakers.json` as `calendarAttendees: string[]`, next to the
  existing `speakerNames` / `speakerRegistry` maps.

That's the whole persistence story. No new file, no new format.

### 6.2 Free win: attendee names as whisper vocabulary

`vocabulary.ts` already folds custom terms into the whisper `--prompt` for both the live and
final passes, sized against a 200-char budget. Participant names are precisely the tokens
whisper mangles most, and we now have them per-session. Pass the session's attendee list through
the same `toPromptSuffix()` budget as file-based terms (file terms first, attendees fill the
remainder).

This is the highest value-to-effort item in the whole participants idea, and it needs no UI at
all: "Аня, передай Ивану" starts transcribing as names instead of noise. Granola does the same
thing in spirit — it feeds attendee metadata into note generation as context.

### 6.3 Suggesting the mapping

Extend `meet rename`'s existing error path plus one new read-only command:

```
$ meet speakers suggest ~/Meetings/2026-08-05_10-00-weekly-sync
Speaker 1  18m 42s  ← registry: "Anna Petrova" (0.84)
Speaker 2   7m 05s  ← unnamed
Others      1m 12s

From calendar: Anna Petrova, Ivan S., Maria K.
Unassigned:   Ivan S., Maria K.

  meet rename <dir> "Speaker 2" "Ivan S."
```

Everything it prints already exists on disk: talk time from `talk-time.ts`, registry matches and
scores from `speakers.json.speakerRegistry`, the attendee list from §6.1. It's a formatter over
existing data plus the copy-pasteable `meet rename` line that already does the real work
(transcript + footer + index + registry propagation). No interactive TUI, no new state.

**Deliberately not auto-assigning.** With 2 speakers and 2 attendees the mapping looks
determinable, but a wrong auto-assignment writes a name into the *cross-session registry*, where
it silently mislabels every future meeting. Suggest, let the human confirm. (The one auto-step
already implemented and safe: registry voice matching, which is identity-based, not
name-guessing.)

**Menubar version, later**: after finalize, a notification "2 unnamed speakers — assign?"
opening a small picker of attendee names. Only worth building after the CLI version proves the
suggestion quality. Vowen ships exactly this idea in its lightest form — name autosuggest from
names you've used before, which our registry already provides.

### 6.4 Privacy note

Attendee names are PII landing in `~/Meetings/*/speakers.json` and, via §6.2, in the transcript
text itself. Local-only, same as everything else here, but transcripts do get shared — worth one
line in the README rather than a surprise.

---

## 7. Competitive check

Requested as part of the review: who ships this, and what else is worth copying.

### 7.1 How others decide what to record

| Product | Trigger | Notes relevant to us |
|---|---|---|
| **Granola** | Calendar is *context only* — recording starts when you open the note for the meeting. No bot, captures system audio + mic like we do. | Excludes declined events and OOO / Focus Time / Working Location blocks (→ §2.1). Auto-stops after 15 audio-free minutes (→ our `--no-text-timeout`, §2.7). Feeds meeting details + attendees into note generation (→ §6.2). |
| **Otter** | Default rule + per-event override: *has a video link* / *I'm the organizer* / *external guest* / *manual*. Toggling a recurring event applies to the whole series. | "Has a video link" is our v1 rule verbatim — good validation. The per-event override is their stickiest feature (→ §7.3). |
| **Fathom** | Meeting type by email domain (internal / external / all / none) + a separate toggle for impromptu meetings incl. Slack huddles. | The internal/external split needs a corporate domain; not useful for a personal tool. The *impromptu* category is the real gap (→ §7.2). |
| **MacWhisper / Circleback** | **Mic-in-use detection**, not calendar: watch for an allowlisted app taking the microphone → "Meeting Detected" notification → record. Auto-stop when the mic is released. | The strongest idea nobody in the calendar camp has (→ §7.2). |
| **MeetMic** | Auto-detect start & end from Apple Calendar. | Closest direct analogue to this spec. |
| **Recall.ai / Nylas** | Bot joins the call, reads participant identity from the platform. | Only path to *real* speaker names — requires a bot, out of scope (→ §6). |
| **Meetily / Hyprnote (→ Anarlog)** | Local-first, diarization, no bot. Calendar integration still "coming soon" in Meetily. | The local-first cohort has *not* shipped this yet. |

### 7.2 Worth replicating next: mic-in-use meeting detection

The one feature that would outperform this whole spec, and it fits this codebase unusually well:

- Calendar auto-start only covers *scheduled* calls. Ad-hoc Zooms, Slack huddles, someone
  calling you — the majority of "damn, I forgot to record" moments — have no calendar event.
- It provides a real **auto-stop** signal (mic released = call over), replacing the +8-minute cap
  guesswork with a fact.
- We already talk to the exact Core Audio API family it needs: `SystemAudioCapture.swift` uses
  the macOS 14.2+ process-tap API, whose `kAudioHardwarePropertyProcessObjectList` /
  `kAudioProcessPropertyIsRunningInput` properties answer "is any process recording input right
  now" directly — no polling `NSWorkspace`, no new permission (we already hold
  System Audio Recording).
- Shape it like MacWhisper's: bundle-ID allowlist (Zoom, Chrome, Safari, Slack, Teams, Telegram,
  Discord, Arc), a notification with a short countdown rather than a silent start, and a "Keep
  Recording" escape hatch when the end is falsely detected.

Recommendation: ship calendar auto-start as specced, then this as the next spec. They compose —
calendar supplies the title, the cap, and (§6) the attendees; mic detection supplies the trigger
and the stop.

### 7.3 Smaller ideas, ranked

1. **Per-event opt-out** (Otter). Menubar: "Skip Next Meeting" while idle, and "Don't auto-record
   this series" after an unwanted start. Cheap: one more `Set` of occurrence keys in
   `UserDefaults`. Defer until a wrong start actually annoys you.
2. **"Next: <title> in 12m" in the menu** — already folded into §2.8. Do it with phase 1.
3. **Event notes / agenda as summary context** (Granola). We already write `meta.md`; appending
   the event description gives the opencode index pass real context for free.
4. **Recording disclosure**. Fathom asks attendees for consent; Granola explicitly warns that it
   does not notify anyone and that this may be a legal requirement depending on jurisdiction.
   Ours is local audio-only with no bot, so there's nothing to build — but a README line
   ("participants are not notified; disclose it yourself") is honest and free.
5. **Auto-share / auto-summary distribution** — every commercial product's core loop, and
   deliberately not ours. Skip.
