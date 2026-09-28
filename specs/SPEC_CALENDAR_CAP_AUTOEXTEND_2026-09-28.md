# SPEC: Calendar Cap Auto-Extend + Hard Ceiling

**Date:** 2026-09-28
**Status:** Draft — pre-implementation (rev 4, headless UX and notch incident follow-up)
**Owner:** Dmitrii Diakonov

---

## 1. Problem

A calendar-auto-started recording (`SPEC_CALENDAR_AUTOSTART_2026-08-04.md`) cut off mid-conversation
at ~38 minutes. Root cause traced from `transcript.md` (continuous speech up to the last entry, no
trailing silence) to `CalendarAutoStartController.swift:startIfPermitted()` → `CalendarMatch.capMinutes()`
(`native/MenuBar/Sources/MeetMenuBar/CalendarMatch.swift:54-64`, §2.7 of the auto-start spec):

```
remaining = ceil((event.end - now) / 60)
grace     = nextQualifyingStart == nil ? 8 : clamp(floor((nextStart - end)/60) - 1, 0, 8)
cap       = max(1, remaining + grace)
```

The cap is computed **once**, at auto-start time, from the calendar event's scheduled end. If the
real conversation outlasts the scheduled slot, `recorder.ts:checkAutoStop()` stops it dead at
`cap`, with at most 8 minutes of blind grace and zero warning. `session.json` (which carries
`autoStopReason`) is deleted at the end of `finalize`, so after the fact there is no record of
*why* a recording stopped — this postmortem only worked because the transcript's own shape
(no silence tail) pointed at a hard cutoff rather than a crash.

## 2. Decisions locked in from discussion

- **Soft cap stays a real deadline, not vanishes.** At the existing soft cap (today's `remaining +
  grace`), instead of stopping unconditionally, check whether the conversation is still active. If
  yes, push the cap forward in small increments instead of one large blind grace window.
- **Auto-extend defaults on for calendar sessions.** `CalendarAutoStartController` supplies the
  eligibility flag (§4.2); config disables it globally and manual extend disables it per session.
  An ordinary manual `meet start --max-duration N` cap means
  exactly what the user typed, and is never auto-extended. Scope stays narrow rather than changing
  `maxDurationMinutes` semantics globally.
- **Auto-extend reserves room before a known successor.** The extension budget is clamped to end
  1 minute before the next qualifying event's start (§3.1). This is a budget at calendar evaluation
  time, not a guaranteed wall-clock handoff; the existing soft cap is never shortened. While a
  recording is running the controller drops every other candidate (auto-start spec step 5), and once the next event is past
  its lateness gate it never auto-starts — so an extension that runs into the next meeting silently
  costs that meeting its recording. This is the same bug §2.7 of the auto-start spec was written to
  prevent. Eligibility is decided by *how much room there is* before the next event, not by whether
  one was found (an unseen event is not the same as no event — see the fetch-window fix in §3.1).
- **A hard ceiling always wins.** Independent of activity, a session auto-extends at most up to
  `2 × scheduled event length`, measured in effective (pause-excluded) elapsed time from recording
  start — same clock as `--max-duration`. Reached → stop, no exceptions from this feature (a human
  can still press `e` / menu bar "Extend +15m" / `SIGWINCH` **before shutdown starts**, same as
  today; an already-triggered stop cannot be canceled).
- **The hard ceiling never lands before the soft cap.** For short events (`scheduled < ~8 min`),
  `2 × scheduled` is smaller than `remaining + 8`; the hard ceiling is floored at the soft cap so
  this feature can never stop a session earlier than today's behavior would.
- **Warn before the hard stop**, not after. A macOS notification (same channel as `attention.ts`)
  is attempted once after an extension, within the configured lead window. It warns of the maximum
  remaining time; silence can still stop the session sooner, and notification delivery is best-effort.
- **Manual extend disables auto-extend for the rest of the session.** The moment a human presses
  `e` / triggers `SIGWINCH`, they've taken explicit control of the cap — auto-extend logic backs
  off entirely rather than fighting or compounding with a manual `+15m`.
- **Persist the stop reason past `finalize`.** `session.json` (which has `autoStopReason`) is
  deleted once finalize completes; add one line to the already-durable `meta.md` so "why did this
  stop" is answerable after the fact without re-deriving it from transcript shape, like this spec
  had to.

### Non-goals

- No change to `--max-duration` / `--text-timeout` CLI semantics for manual sessions.
- No UI for tuning the new thresholds — config file only, same convention as
  `noTextTimeoutMinutes`.
- No retroactive fix for the already-deleted `session.json` of past sessions — `meta.md`
  persistence is forward-looking only.
- No dynamic re-check of the calendar while recording. An event created or moved *during* the call
  (after auto-start) is not seen; the hard ceiling was computed at start. Known residual risk,
  bounded by the hard ceiling itself.

---

## 3. Behavior

### 3.1 Eligibility and hard-ceiling computation (Swift)

At auto-start, `CalendarAutoStartController.startIfPermitted()` already computes `nextStart` and
`softCap = capMinutes(now:end:nextStart:)`. Keep that existing soft-cap calculation. For the new
extension ceiling, select the earliest **future** qualifying occurrence other than the winner and
already-resolved occurrences, including events starting **before** the winner's end. The existing
`CalendarMatch.nextStart(after: candidate.end, ...)` cannot serve this purpose: it misses overlapping
successors. Call the new value `extensionNextStart`. It additionally computes:

```
scheduledMinutes     = ceil((candidate.end - candidate.start) / 60)
ceiling              = 2 * scheduledMinutes                              // multiplier first, on the ceiled duration
if extensionNextStart != nil:
    ceiling          = min(ceiling, floor((extensionNextStart - now) / 60) - 1)
ceiling              = min(ceiling, lookaheadMinutes)                    // never extend past what the fetch could see
hardCap              = ceiling > softCap ? ceiling : nil                 // no room to extend → no flag
```

and passes a new CLI flag **only** when `hardCap != nil`:

```
--calendar-hard-cap <minutes>
```

`<minutes>` is elapsed-from-recording-start, same units and clock as `--max-duration`. Absence of
the flag (manual sessions, calendar sessions with no room before the next event, or events so short
that the ceiling doesn't exceed the soft cap) means: unchanged behavior, exactly today's single stop
at `maxDurationMinutes`.

Note the ceiling is floored at the soft cap by construction: when `2 × scheduled ≤ softCap` (short
events) the flag is simply omitted, so the session keeps today's soft-cap stop instead of being
stopped earlier.

**Fetch window.** `nextStart` only considers events returned by the controller's periodic fetch,
which today spans `now - 15 min … now + 90 min` (`lookaheadMinutes`, `CalendarAutoStartController.swift:14`).
A 60-minute event with a 120-minute ceiling would not see a successor starting 45 minutes after its
end, and would treat it as "no successor". `lookaheadMinutes` is raised from `90` to `240`, which
covers the full 2× ceiling for any event up to 2 hours; longer events are clamped to the fetch
horizon by the `min(ceiling, lookaheadMinutes)` line above, so the ceiling never extends past what
the fetch could see. (The fetch is a local EventKit query on an existing timer; the wider window
must be checked for acceptable latency. Side effect: the menu bar's "next event" summary can now
show events up to 4 h ahead instead of 90 min.)

**Limits of the successor protection.** The calculation uses the fetch's `now`, whereas Node's
elapsed clock starts at `session.startedAt`, after fetch/dispatch, runner resolution and startup.
That delay, minute rounding in the unchanged soft cap, the 5s check cadence, and shutdown/lock
release latency mean this feature cannot guarantee a one-minute wall-clock gap or an on-time
successor start. A back-to-back or overlapping event may already be covered by today's soft cap;
omitting the flag preserves that behavior rather than repairing it. Pauses/manual extension and
calendar edits are additional exceptions (§3.4). An absolute wall-clock deadline and bounded
handoff would be a separate change; acceptance here is that auto-extension never exceeds the
computed elapsed budget, subject to the status tick. The fetch-horizon bound likewise applies
to this budget, not to paused wall-clock time.

A new config field, `calendarCapAutoExtend` (default `true`), is a global kill switch checked
Node-side (read from the `Config` loaded at recorder construction, i.e. takes effect on the next
session) — set `false` to fall back to today's behavior without rebuilding `Meet.app`.

### 3.2 Soft cap → activity check → extend

Decision logic lives in a new pure function (§4.2) that `recorder.ts:checkAutoStop()` calls on each
5s status tick. When `calendarHardCapMinutes` is set, `calendarCapAutoExtend` is `true`, and auto-
extend hasn't been disabled by a manual extend:

```
if elapsedSec >= hardCapMinutes * 60:
    stop (autoStopReason = "calendar_hard_cap")
elif elapsedSec >= maxDurationMinutes * 60:
    if queueLagChunks > calendarCapAutoExtendMaxLagChunks
       or noTextGapSec < calendarCapAutoExtendActivityWindowMinutes * 60:
        proposedCap = min(hardCapMinutes, elapsedSec / 60 + calendarCapAutoExtendStepMinutes)
        propose extension to proposedCap (apply only if no stop wins below)
    else:
        stop (autoStopReason = "max_duration")     // unchanged today's path
```

Otherwise (flag absent, kill switch off, or manual override set) the existing single
`maxDurationMinutes` check runs unchanged. Preserve the existing stop precedence: a reached hard
cap wins first; a soft-cap stop wins next; then check `noTextTimeoutMinutes`. If that timeout is
due, return `stop: no_text_timeout`, discard any proposed extension, and suppress warnings.
Otherwise apply the proposed extension, increment `autoExtendCount`, and evaluate the warning
using the resulting count on the **same tick**. Log whether activity or queue lag caused the
extension. Neither an extension nor a warning may skip or defer the no-text check.

**Activity signal.** Reuses `noTextGapSec()` (`recorder.ts:623-629`) — the same processed-seconds-
since-last-meaningful-text metric `noTextTimeoutMinutes` uses — with a separate, tighter threshold
purpose-built for "is this decision point live right now," not "has the whole call gone dead."

**Queue lag guard.** `noTextGapSec()` is measured on the *processed* timeline
(`latestProcessedOffsetSeconds`). If the whisper queue is behind, the most recent audio hasn't been
transcribed yet, and fresh speech or silence in it is invisible — the gap can understate or
overstate current inactivity. When queue lag (`max(0, micChunks + sysChunks - stats.totalDone)`, the same number
`formatLagStatus` already renders) exceeds `calendarCapAutoExtendMaxLagChunks`, the decision is
deferred by extending one step instead of stopping. This fails toward recording; the hard ceiling
still bounds it.

**Cadence.** Each extension moves the soft cap `step` minutes past the current elapsed time, so the
activity check re-runs once per step boundary — not a burst of extensions per tick. Net behavior:
the session stops at the first step boundary where the last `activityWindow` minutes (processed
timeline) contained no meaningful text. Worst-case silent tail after the call actually ends is
the activity window plus one step (default roughly 8 min), plus chunk/processing delay and tick
jitter when the queue is keeping up. With persistent lag, extension can continue until the hard
ceiling (unless the independent no-text timeout wins); there is no five-minute silent-tail
guarantee. Compute the new cap from `elapsedSec / 60`, retaining fractional minutes internally,
so a delayed tick does not cause a burst of catch-up extensions. Piggybacks on the existing
`startStatus()` interval, no new timer.

### 3.3 Hard-cap warning

A one-shot flag (`hardCapWarningSent`) guards a single macOS notification. It fires when **both**:

- at least one auto-extension has happened (`autoExtendCount > 0`), and
- `elapsedSec >= hardCapMinutes*60 - calendarCapWarningLeadMinutes*60`.

Both conditions are evaluated only while adaptive mode is enabled, before the hard stop, and
after any extension selected on the current tick. A stop decision emits no warning. The first
condition keeps the warning from firing while the session is still inside its normal
soft-cap window. Example: a 10-minute event gives soft cap 18 and ceiling 20. Without the gate, the
warning would fire at minute 15, before any extension. It would claim the hard limit is near, even
though the session could stop quietly at 18 on silence. In that example the warning accompanies
the extension to 20. This is not a general clamp condition: soft 23 / hard 30 extends to 28 at
minute 23 and warns at minute 25, before the next extension. Silence can still stop it at 28.

Message text includes the remedy, since headless sessions have no terminal:

> "Calendar limit in ~N min; recording may stop sooner on silence. Menu bar → Extend +15m to raise the limit."

`N = ceil((hardCapMinutes * 60 - elapsedSec) / 60)`. A late first extension may leave less than
the configured lead; warn immediately rather than promising a full lead window. If the process
misses the entire window (sleep or stalled event loop), stop on the first overdue tick without a
late notification. Mark the attempt sent synchronously before dispatching the notification,
catch failure, and never await it in the status/stop path or retry on every tick.

Delivered via the same `execFile("osascript", …)` pattern as `attention.ts:buildNotificationArgs`/
`sendMacNotification` — headless (menu-bar-started) sessions have no terminal to print a status
line to, so this must go through the notification channel, not stdout. It is **not** gated on
`config.attentionAlerts` (that toggle is for trigger-word alerts only). See §4.2 for the small
shared-helper refactor this implies.

When the hard cap itself is reached, stop exactly like today's `max_duration` path, with a distinct
`autoStopReason: "calendar_hard_cap"` so it's visible in `meta.md` (§3.5) that this was the ceiling,
not the adaptive soft cap giving up.

### 3.4 Interaction with existing mechanisms

- **Manual extend wins.** `extendCap()` (`recorder.ts:734-744`, hotkey `e` / menu bar "Extend +15m"
  → `SIGWINCH`) sets `manualCapOverride = true`. While set, `checkAutoStop()` skips the auto-extend
  branch entirely — elapsed reaching the (now manually-raised) `maxDurationMinutes` stops the
  session the ordinary way (`max_duration`), and `hardCapMinutes` is ignored for the remainder of
  the run. A human who reached for `e` already made the call explicitly; auto-extend backing off
  avoids two mechanisms fighting over the same number.
  Also suppress future cap warnings and the adaptive hard-cap status suffix. A notification
  already delivered cannot be retracted. Calls made after `shuttingDown` is set remain no-ops.
- **`noTextTimeoutMinutes` keeps working unmodified and independently.** It's a separate check in
  the same function, on the same underlying `noTextGapSec()` value but a different (larger, default
  10 min) threshold and different intent ("this call is over, nobody's talking") — a session that
  goes silent well before either cap still stops on schedule, calendar-eligible or not.
- **Pause.** Both caps run on `effectiveElapsedMs()`, which excludes paused time. A pause therefore
  shifts the hard ceiling later in wall-clock time and can push it past the next event's start. That
  is accepted: pausing is an explicit human action, like manual extend.
- **Sessions without room before the next event are untouched** — see §3.1: no
  `--calendar-hard-cap` flag is passed for them, so they hit exactly today's single soft-cap stop.

### 3.5 Status line and meta.md

- The terminal status below is diagnostic only for calendar sessions:
  `RecordingController.start()` sends both stdout and stderr to `FileHandle.nullDevice`.
  It does not give the calendar user visible cap information. See §8.1 for the recommended
  menu-bar status and independent panel-opening path; those additions need a concrete IPC/UI
  contract before implementation and are not implied by the terminal formatter.
- Status line (`startStatus()`, `recorder.ts:657-664`): while adaptive mode remains enabled and
  at least one auto-extension has happened, the cap string also shows the time remaining to the hard ceiling (same `formatClock`
  countdown style as the cap itself), e.g. `cap: 04:12 (ext, hard 22:00)` = 4m12s to the current
  soft cap, 22m00s to the ceiling. Cheap visibility that this session is in adaptive mode, not just
  running long.
- `shutdown()`'s auto-stop label (`recorder.ts:477`, currently a binary
  `max_duration ? "max duration" : "no text timeout"`) becomes a 3-way map, adding
  `calendar_hard_cap → "calendar hard limit"`. Without that change it would print "no text timeout"
  for the new reason.
- `writeMetaFile()` (`tags.ts:44-69`) gains one conditional line, written from
  `session.autoStopReason`. The recorder calls it from `promptTags()` (`recorder.ts:352`), which
  receives the in-memory session after `checkAutoStop()` has set the reason and before
  `session.json` gets deleted:
  ```
  - Auto-stop: calendar_hard_cap
  ```
  Omitted entirely when `autoStopReason` is `null` (manual `q`/`s`/`n` stop), matching the existing
  convention of omitting empty optional lines (see the `gitContext` line). The only other caller,
  `import.ts:212`, always has `autoStopReason: null`, so it is unaffected.

---

## 4. Architecture

### 4.1 Swift (`native/MenuBar/`)

- **`CalendarMatch.swift`** — add a pure
  `hardCapMinutes(scheduledMinutes: Int, softCapMinutes: Int, minutesUntilNextStart: Int?, horizonMinutes: Int) -> Int?`
  implementing §3.1 (`nil` = no room to extend, don't pass the flag). The multiplier `2` is a named
  constant next to the existing grace-clamp `8`. Add a separately testable future-successor
  selector for the extension ceiling; leave `nextStart(after:starts:)`'s soft-cap behavior intact.
  Extend `selfCheck()` per §7.
- **`CalendarAutoStartController.swift`**:
  - `lookaheadMinutes` `90 → 240` (§3.1 fetch window).
  - In `startIfPermitted()`, after the existing `nextStart`/`cap` lines, compute
    `scheduledMinutes = ceil((candidate.end - candidate.start) / 60)` and
    select `extensionNextStart` per §3.1, compute
    `minutesUntilNextStart = extensionNextStart.map { Int(floor($0.timeIntervalSince(now) / 60)) }`, call
    `CalendarMatch.hardCapMinutes(...)` with `horizonMinutes: Int(Self.lookaheadMinutes)`, and pass
    the result through to `RecordingController.start(...)`.
- **`RecordingController.swift`** — `start(title:maxDurationMinutes:attendees:)` gains
  `hardCapMinutes: Int? = nil`; appends `["--calendar-hard-cap", "\(h)"]` when set. Manual Start
  (menu click) keeps calling without it → unchanged.
- **`main.swift`** — no change; `CalendarMatch.selfCheck()` is already wired via
  `--self-test-calendar`.

### 4.2 Node (`src/`)

- **`cli.ts`** — new `.option("--calendar-hard-cap <minutes>", …, parsePositiveInteger)` on the
  `start` command (positive, not non-negative: `0` has no meaning here). Threaded through
  `startSessionLoop`/`startSession` the same way `--max-duration` already is, down into
  `RecorderOptions`.
  Validate before creating session files or starting capture: an explicit positive
  `--max-duration` is required and `calendarHardCapMinutes > maxDurationMinutes`; reject invalid
  combinations even when the config kill switch is off. Document this as an internal calendar
  launcher opt-in: Node cannot authenticate the caller, so a user explicitly supplying the flag
  opts in too. Ordinary manual starts remain unchanged. Do not carry calendar eligibility into
  the `n` hotkey's next recording: clear this flag after the first loop iteration (preserve
  existing `--max-duration` loop behavior).
- **`auto-stop.ts`** (new) — pure, exported
  `decideAutoStop(state, opts, cfg): AutoStopDecision`, where:
  - `state` = `{ elapsedSec, noTextGapSec, queueLagChunks, autoExtendCount, manualCapOverride, hardCapWarningSent }`
  - `opts` = `{ maxDurationMinutes, noTextTimeoutMinutes, calendarHardCapMinutes? }`
  - `AutoStopDecision` = `{ kind: "stop", reason } | { kind: "continue", extension?: { newMaxDurationMinutes, cause: "activity" | "queue_lag" }, warning?: { minutesLeft } }`

  A continuing decision can extend **and** warn on one tick; a stop cannot include either effect.
  An empty `continue` means no action. If both activity and lag qualify, use `queue_lag` as the
  logged cause. The precedence is exactly §3.2; compute any warning from the post-extension
  count without mutating inputs. No-text timeout remains independent even when lag is high.

  This covers §3.2, §3.3, and the existing `noTextTimeout` check. It follows the same pattern as the
  pure helpers `recorder.test.ts` already covers (`formatLagStatus`, `planRetitle`): `Recorder`
  itself (pipeline, capture process) is not unit-testable, so the logic has to live outside it.
- **`recorder.ts`**:
  - `RecorderOptions` gains `calendarHardCapMinutes?: number`.
  - `checkAutoStop()` becomes a thin shell: build the state, call `decideAutoStop`, apply the result
    (apply extension and/or warning, or run the existing stop path). Keep the current
    `shuttingDown`/`autoStopReason` guards; a stop sets both the private and session reason before
    invoking shutdown. Apply extension and one-shot fields synchronously; notification I/O is
    fire-and-forget with a caught rejection.
  - New private fields: `manualCapOverride`, `hardCapWarningSent`, `autoExtendCount`.
  - `extendCap()` sets `manualCapOverride = true`.
  - The private `autoStopReason` field (`recorder.ts:35`) widens along with `Session`'s.
  - `shutdown()` label is a 3-way map (§3.5).
  - `startStatus()` cap string per §3.5.
- **`types.ts`**:
  - `Config` gains `calendarCapAutoExtend`, `calendarCapAutoExtendStepMinutes`,
    `calendarCapAutoExtendActivityWindowMinutes`, `calendarCapAutoExtendMaxLagChunks`,
    `calendarCapWarningLeadMinutes`, with defaults in `DEFAULT_CONFIG` (§6).
  - `Session.autoStopReason` widens to
    `"max_duration" | "no_text_timeout" | "calendar_hard_cap" | null`.
- **`storage.ts`** — add range guards for all four numeric config additions (§6), using the
  existing default-and-warn behavior for invalid file values. Defaults alone do not validate
  ranges: without these guards a zero/negative step causes repeated extensions at an expired cap.
- **`attention.ts`** — factor the notification mechanics out of `buildNotificationArgs`/
  `sendMacNotification` (currently hard-typed to `AttentionAlert`) into a generic
  `sendPlainNotification(title: string, message: string, sound: string): Promise<void>`; both the
  existing trigger-word alert and the new cap warning call it. Small refactor, two real call sites,
  no speculative generality beyond that. Preserve `buildNotificationArgs`' existing public
  contract via a wrapper over a generic builder; keep message truncation/control stripping and
  argv-based AppleScript (never interpolate title/message/sound into script source). Use `Glass`
  for the cap warning, independent of trigger-alert config. Keep the Extend hint within the
  notification length limit.
- **`tags.ts`** — `writeMetaFile()` gains the conditional `- Auto-stop: …` line (§3.5), sourced from
  `session.autoStopReason`.

No changes to `finalize.ts` or the whisper/diarization pipeline. Config validation in `storage.ts`
is part of this change. The metadata guarantee covers normal recorder shutdown; a crash before
`promptTags()` writes `meta.md` is not repaired by this feature.

**Naming:** Swift side uses `hardCapMinutes`; Node side uses `calendarHardCapMinutes` (matches the
CLI flag and makes the calendar-only scope explicit in `RecorderOptions`).

---

## 5. Files touched

| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/CalendarMatch.swift` | `hardCapMinutes()` (floored at soft cap, clamped to next start + fetch horizon) + `selfCheck()` cases |
| `native/MenuBar/Sources/MeetMenuBar/CalendarAutoStartController.swift` | `lookaheadMinutes` 90→240; compute + pass `hardCapMinutes` |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | `start()` gains `hardCapMinutes: Int?`, appends `--calendar-hard-cap` |
| `src/cli.ts` | `--calendar-hard-cap <minutes>` (`parsePositiveInteger`), threaded to `RecorderOptions` |
| `src/auto-stop.ts` (new) | pure `decideAutoStop()` |
| `src/auto-stop.test.ts` (new) | unit tests per §7 |
| `src/cli.test.ts` | flag validation and session-loop eligibility tests |
| `src/recorder.ts` | `checkAutoStop()` delegates to `decideAutoStop`; new fields; `autoStopReason` field type; `shutdown()` label; status line |
| `src/types.ts` | new `Config` fields + defaults, `autoStopReason` union widened |
| `src/storage.ts`, `src/storage.test.ts` | numeric range guards and invalid-value fallback tests |
| `src/attention.ts` | extract `sendPlainNotification()` shared helper |
| `src/attention.test.ts` | notification formatting, escaping and existing alert compatibility |
| `src/tags.ts` | `writeMetaFile()` conditional `- Auto-stop:` line |
| `src/tags.test.ts` | all stop reasons and omitted reason metadata tests |
| `CLAUDE.md` | mention `auto-stop.ts` in the module breakdown |
| `README.md` | CLI Commands, Features and Configuration entries |
| `docs/features.md`, `docs/ru/features.md` | matching `FEATURES:core-recording`, `FEATURES:reliability`, `FEATURES:cli-reference`, `FEATURES:config-reference` blocks |

Follow the repository documentation-sync contract in the implementation change: CLI source,
README, English site and Russian site ship together. Translate prose only; marker names, flags,
config keys and commands remain identical. Do not document the feature as shipped in this draft-only review.

---

## 6. Config additions

| Key | Default | Meaning |
|---|---|---|
| `calendarCapAutoExtend` | `true` | Global kill switch. `false` reverts calendar-originated sessions to today's single stop at the soft cap, no Swift rebuild needed (takes effect next session). |
| `calendarCapAutoExtendStepMinutes` | `5` | Positive safe integer. Minutes beyond the current elapsed time granted per extension, clamped to the hard cap. Silent tail also includes the activity window and processing delay. |
| `calendarCapAutoExtendActivityWindowMinutes` | `3` | Positive safe integer. Call counts as active when `noTextGapSec()` is strictly less than this many minutes. Tighter than the default `noTextTimeoutMinutes` (10). |
| `calendarCapAutoExtendMaxLagChunks` | `2` | Non-negative safe integer. If queue lag strictly exceeds this, propose an extension (the activity signal is stale). The no-text timeout can still stop the session. `2` represents one mic+sys pair in flight. |
| `calendarCapWarningLeadMinutes` | `5` | Positive safe integer. Lead window for a single notification attempt, only after at least one auto-extension. Short headroom or delayed ticks can reduce actual notice. |

Invalid file values fall back to the corresponding defaults via `sanitizeFileConfig`; wrong
types and non-finite values use its existing checks. Normalize equivalent invalid values from
programmatic overrides before calling the pure decision helper. Capture these settings once per
recorder, so numeric edits and the kill switch all take effect on the next session.

The `2×` hard-cap multiplier is **not** a config key. It is hardcoded in `CalendarMatch.swift` next
to the existing grace-clamp `8`, matching this codebase's convention of not adding a config surface
until there's a proven need to edit it often (see `SPEC_CALENDAR_AUTOSTART_2026-08-04.md` §2.1's
identical reasoning for the hardcoded call-link domain list).

---

## 7. Testing

**Automated — `CalendarMatch.selfCheck()`** (`--self-test-calendar`):
- No successor: `hardCapMinutes(scheduled: 30, softCap: 38, next: nil, horizon: 240) == 60`;
  `(45, 53, nil, 240) == 90`.
- Short event, ceiling ≤ soft cap: `(3, 11, nil, 240) == nil`; `(8, 16, nil, 240) == nil`;
  `(10, 18, nil, 240) == 20`.
- Successor clamps the ceiling: `(60, 68, next: 105, 240) == 104` (successor 45 min after a 60-min
  event's end, i.e. 105 min from start → ceiling 104, not 120).
- Successor leaves no room: `(30, 38, next: 38, 240) == nil`.
- Horizon clamps long events: `(180, 188, nil, 240) == 240`.
- Future successor selection includes overlap: winner `[0, 60]`, future event `[50, 80]`
  → extension successor at 50 and no extension flag (soft cap remains unchanged). Exclude the
  winner, already-resolved occurrences, and starts at/before `now`; preserve the existing
  soft-cap successor tests including equality at the event end.
- Fractional timing: a successor in 105m30s gives integer budget 104m; scheduled duration
  30m01s gives a 62m pre-clamp ceiling. Short/horizon cases where ceiling ≤ soft cap return nil.

**Automated — `auto-stop.test.ts`** (pure `decideAutoStop`, no mocks needed):
- Soft cap reached, gap small → `continue` with extension; next tick before the new cap and
  outside the warning window → empty `continue`.
- Soft cap reached, gap large, lag small → `stop: max_duration`, unchanged from today.
- Soft cap reached, gap large but below no-text timeout, lag > `maxLagChunks` → extension
  with cause `queue_lag` (stale-signal guard).
- At exactly the activity-window threshold, text is inactive; lag exactly equal to the
  threshold does not trigger the lag guard. No processed text has gap 0 and can extend via the
  existing activity metric, but remains bounded by the hard cap.
- Delayed tick: soft 38, elapsed 47m20s, step 5, hard 60 → cap 52m20s, one increment;
  following tick does not extend again. Never round this internal cap down to an integer minute.
- Repeated extensions clamp at `calendarHardCapMinutes`; never overshoots with continuous activity.
- Elapsed ≥ hard cap → `stop: calendar_hard_cap`, regardless of activity.
- Warning is present exactly once when post-decision `autoExtendCount > 0` and within lead;
  absent while the count stays zero (soft 18, hard 20, elapsed 15 → empty `continue`).
- First extension inside the lead window returns extension and warning together (soft 18,
  hard 20, elapsed 18, active → cap 20 and warning 2m); a silent soft stop returns no warning.
- Large configured lead may warn before the soft cap reaches the hard cap; subsequent silence
  still stops at the soft cap. A tick past the hard cap stops without a warning.
- `manualCapOverride: true` → soft-cap hit stops with `max_duration` even with high activity; hard
  cap ignored, no warning, including after previous auto-extensions.
- `calendarHardCapMinutes` undefined → identical decisions to today's two checks (table-driven
  against the current `max_duration`/`no_text_timeout` behavior).
- `calendarCapAutoExtend: false` → `calendarHardCapMinutes` ignored entirely.
- `noTextTimeout` still fires independently before either cap.
- Simultaneous conditions: hard cap + no-text → hard-cap reason; silent soft cap + no-text →
  max-duration reason; proposed lag extension + no-text → no-text reason with no extension;
  warning due + no-text → no-text reason with no warning. Disabling no-text (`0`) skips it.

**Automated — integration boundaries**:
- CLI rejects zero/negative/fractional/non-finite hard caps, missing/zero soft caps, and hard caps
  ≤ soft caps before any session/capture side effects; valid values reach `RecorderOptions`.
  Manual starts omit the flag; `n` follow-on recordings do not inherit calendar eligibility.
- `storage.test.ts`: zero/negative/fractional step, activity and warning settings default safely;
  lag threshold accepts 0 but rejects negative/fractional values. Include wrong types/non-finite
  values and config loaded without new fields. Cover override normalization separately.
- `attention.test.ts`: preserve existing trigger-alert args; cap warning retains the Extend hint;
  quotes, backslashes and control characters in text cannot alter the AppleScript source.
  With a rejected notification promise, the recorder integration catches the error, records
  one attempt and continues checking caps; `attentionAlerts: false` does not suppress it.
- Recorder integration: manual extend removes adaptive status; stopping sets both reason fields
  before shutdown; a warning dispatch does not delay a simultaneous extension or later stop.

**Automated — `tags.test.ts`**: `writeMetaFile` emits each of the three `- Auto-stop: <reason>`
values when set, and omits the line when `null`/absent on legacy sessions. Cover empty tags,
headless shutdown, and preservation alongside the existing repo line and optional note.

**Manual**:
- Calendar test event **15 min** long (soft cap ≈ 23, ceiling 30), keep talking past its end → cap
  extends in 5-minute steps, notification (with the Extend hint) fires at ~25 min, session stops
  at 30 if talking continues through the warning. Verify intermediate caps through captured
  diagnostic output in a test build or a foreground CLI reproduction with the same cap flags;
  the normal calendar launcher discards the terminal status. Separately exercise the real
  headless path for notification delivery and menu-based Extend.
- Same event, go silent right after the scheduled end → stops at the original soft cap (or the first
  step boundary after 3 silent minutes), no hard-cap warning.
- Calendar test event **3 min** long → no `--calendar-hard-cap` in the spawned args
  (`ps -o args`), stops at the soft cap exactly like today.
- Pair with a successor 10 min after the first event's end → elapsed ceiling uses the successor
  budget minus 1 min; verify the actual second-event start and measure startup/shutdown delays.
- Back-to-back pair (0-min gap, as in the auto-start spec's manual tests) → no flag passed, first
  session never auto-extends. Record the actual handoff time; this change does not guarantee an
  on-time start or repair the existing soft-cap/handoff delays (§3.1).
- Overlapping future event → no extension flag when its start is inside the existing soft cap.
- Pause/resume shifts the effective deadline; manual extend suppresses future cap notifications
  and adaptive status. Attempting Extend after shutdown begins does not resume recording.
- Press `e` (or menu bar "Extend +15m") once during an auto-extending session → no further
  auto-extends; manual cap governs for the rest of the run.
- After finalize, `meta.md` shows `- Auto-stop: calendar_hard_cap` (or `max_duration`, or is omitted
  for a manual `q`) matching what actually happened; terminal/log label matches.

---

## 8. Open questions for review

- **Step size (5m), activity window (3m) and lag threshold (2 chunks) are first guesses**, not
  measured against real meeting-overrun patterns. Cheap to tune post-ship since all are config, not
  compiled constants.
- **Hard-cap multiplier remains 2×**, as locked in §2 ("столько же, сколько был звонок").
  A larger floor is outside this implementation; short slots intentionally get less headroom.
- **Hallucination keeps the call "active".** Whisper can produce "meaningful" text from music or
  hold audio (or hallucinate it on near-silence that passes gating). That keeps the activity signal
  fresh, and a dead call keeps extending until the hard ceiling. The ceiling limits the damage;
  revisit if `meta.md` shows many `calendar_hard_cap` stops on sessions whose tail is junk.

### Resolved in review

- Rev 3: extension is measured from current elapsed time; effects can extend and warn together;
  stop precedence preserves no-text checks; manual override suppresses warnings/status; invalid
  config and flag combinations are defined; future overlapping successors are considered;
  silent-tail and calendar-handoff guarantees are corrected; documentation sync is required.
- A macOS notification is necessary for the headless path, but its sufficiency is **reopened**:
  stdout is discarded and the user reported the notch panel unavailable during the cut-off call.
  A notification attempt plus an inaccessible panel is not a reliable control/visibility path.

### 8.1 Follow-up recommendations: headless visibility and the reported notch failure

**Incident evidence (2026-09-28):** the user could not reveal the notch panel while the same
cut-off call was still recording. Display setup, full-screen/Space transitions, menu responsiveness,
and the running app build are not yet established. Do not attribute this to the calendar cap:
the recording deadline and panel hover are separate code paths, and the incident has not been
reproduced.

Source-confirmed limitations:

- `NotchPanelController` only reveals via `TrackingView.mouseEntered`; `AppDelegate` provides
  no explicit "Show Transcript" command. `arm()` silently returns when notch geometry is
  unavailable; there is no fallback on a display without a notch.
- `setArmed(true)` retries only when `panel.isVisible != true`. That flag is not proof that the
  panel can receive hover on the active Space. Commit `5ae488e` (2026-09-15) already adds
  re-ordering on Space changes; first verify the running app includes it before diagnosing a
  recurrence. Rebuilding TypeScript alone does not update the Swift app.
- `RecordingController` and the notch view share the app's main thread. Synchronous CLI calls
  and waits exist in the controller; a blocked main thread is another hypothesis if the menu
  was also unresponsive, not an established explanation of this incident.
- The recording menu shows elapsed time but no current cap, hard cap or auto-extension count.
  "Extend +15m" exists in the recording state but is absent from the paused menu.

Recommended additions, in priority order (not yet added to §4's implementation contract):

1. **Explicit panel access:** "Show Transcript" in the recording and paused menus. It must
   reveal without requiring a hover event, cancel pending auto-hide, and remain open until
   dismissed or recording ends. If notch geometry is unavailable, show a normal transcript
   panel on an available display. Define focus/Escape behavior and preserve any in-flight Ask
   response. This is a separate notch-reliability change; auto-extension must work without it.
2. **Visible recording limits:** menu status for the current soft-cap countdown, hard-cap
   countdown while adaptive mode is active, and confirmation after manual Extend. Keep the
   Extend action available while paused. Node remains authoritative: Swift must read a versioned
   status snapshot with session identity and freshness, not recompute deadlines from calendar
   duration or the menu's wall-clock elapsed timer. Specify the atomic writer, reader, update
   cadence, stale/absent fallback, and cleanup before implementing this addition.
3. **Durable explanation:** supplement the stop-reason line with a small machine-readable
   decision log in the output directory. Record initial soft/hard caps and clamp reason,
   extensions with elapsed/gap/lag, manual override, warning attempt/outcome, and stop decision.
   No transcript text or attendee names are needed. Retain after finalize; define schema,
   bounded size and write-failure behavior. A stop reason alone cannot explain why an active
   call failed eligibility or why the activity check decided to stop.

Notch incident investigation/acceptance:

- Identify the app build used for reproduction and distinguish "panel did not open" from
  "panel opened with no transcript". Missing transcript data should show the existing placeholder.
- Reproduce calendar and manual starts with pointer outside/inside the trigger zone at start;
  switch Spaces/full-screen, sleep/wake, connect/disconnect an external display and reopen the lid.
- Record controller state, arm outcome, screen/geometry, order-front and hover transitions in a
  bounded diagnostic log. Avoid per-second log spam and meeting content. If menu and hover both
  freeze, inspect main-thread blocking before changing window ordering again.
- After adding explicit access, verify it independently of hover, with missing notch geometry,
  during pause and after Space changes. Verify the limit status and Extend remain usable without
  the notch panel and when notification banners are not displayed.
