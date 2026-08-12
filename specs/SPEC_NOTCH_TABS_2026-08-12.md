# SPEC: Notch Panel — Ask AI mode

**Date:** 2026-08-12
**Status:** Rev 2 (draft) — pre-implementation
**Owner:** Dmitrii Diakonov

Rev 1 proposed a 4-tab panel (Транскрипт / Спикеры / Ask AI / Действия). Review cut it
to **two modes**: Спикеры became one header line, Действия was dropped as pure
duplication of the status-item menu (§6). What's left is the only part with real value.

---

## 1. Overview

Extend the existing notch panel (`NotchPanelController`, `specs/SPEC_NOTCH_TRANSCRIPT_PANEL_2026-08-03.md`)
with a second mode:

1. **Транскрипт** — today's content, plus one attendee line in the header.
2. **Ask AI** — ask a question about the live transcript via opencode, headless.

The mode switch is one more button in the existing button row next to "Раскрыть" —
no `NSTabView`, no tab strip. Two views can't justify a tab container.

### Non-goals
- **No Спикеры tab.** Live diarization/talk-time is finalize-only (`speakers.json`
  doesn't exist until then), so the tab would only ever show the calendar attendee
  list the user already read in the invite. That's one line, not a tab (§2.1).
- **No Действия tab.** Pause/Resume/Stop/Extend/Tags/Open Folder all exist in the
  status-item menu, ~2cm from the notch. Duplicating them costs a `RecordingController`
  reference inside the panel, an `onStateChange` subscription so the Pause/Resume
  toggle doesn't lie, and a new "open *this* meeting's folder" (the menu's
  `openMeetings` opens `~/Meetings`, not the current meeting) — all for a second
  route to a menu that's already onscreen.
- **No Ask AI history.** Last question/answer only.
- **No keyboard shortcuts.**

---

## 2. UX

### 2.1 Транскрипт (unchanged + attendee line)
`updateTranscript()` prefixes the tail text with `Участники: A, B` when the
active-recording lock carries a non-empty `attendees` (see §3.1), and prefixes
nothing when it doesn't — a manually-started call gets no placeholder line, no
"Нет данных с календаря" noise. Pure string work in the existing update path,
covered by the existing `--self-test-notch` harness.

### 2.2 Ask AI
- Toggled by an "Ask AI" button in the existing button row; pressing it again (title
  flips to "Транскрипт") returns to transcript mode.
- Entering Ask AI mode:
  - stops transcript polling,
  - forces the panel to `bigFrame` (the 160pt hover height can't hold a field, an
    answer, and two button rows — `bigFrame` already exists, it's one call),
  - shows a single-line `NSTextField` + "Спросить" button in a row at the bottom,
  - **reuses the existing `NSTextView`/`NSScrollView` for the answer** — no second
    text view. It shows `Спросите что-нибудь о встрече…` until an answer lands.
- Submit disables field + button and shows `Ждём ответ…`; re-enables on
  answer / error / 60s timeout (`runOpencodeQuestion`'s existing default).
- One in-flight question at a time, enforced Recorder-side by the existing
  `opencodeRunning` guard (`recorder.ts:37`) shared with the interactive `a` hotkey.

### 2.3 Focus and hover-hide — the two things Rev 1 missed
- **The panel must become key.** It's `NSPanel([.nonactivatingPanel, .borderless])`
  (`NotchPanelController.swift:81`) and a borderless window returns `canBecomeKey == false`
  by default, so an `NSTextField` in it can never take keyboard input. Requires an
  `NSPanel` subclass with `override var canBecomeKey: Bool { true }`, and
  `panel.makeKey()` when entering Ask AI mode. (`.nonactivatingPanel` still keeps the
  app itself from activating — same reason `FirstMouseButton` exists at `:318`.)
- **Hover-hide must be suppressed while typing.** `handleHover(false)` schedules
  `collapse()` 0.35s later — the mouse trivially leaves a 620pt panel mid-sentence.
  Rule: skip scheduling the hide when Ask AI mode is active **and** (the field is
  non-empty **or** a question is in flight). An empty field with nothing pending
  still auto-hides normally, so the panel never becomes a dead-end that won't close.
  `disarm()` (recording stopped) still forces it away unconditionally.
- **`collapse()` resets the mode to Транскрипт but keeps `pendingAskId` and the last
  answer.** Rev 1 said state resets *and* that a mid-flight answer survives an
  away-and-back; only the second is worth having. Re-entering Ask AI shows the last
  answer, or resumes polling if the question is still outstanding.

---

## 3. Architecture

### 3.1 Attendees — lock file gains one field
`Session.attendees` (`src/types.ts:44`) already exists and is populated at
`meet start --attendees` (`src/cli.ts:289-311`); it's just never written to the lock
the Swift side reads. Two lines in `src/locks.ts`: `attendees: session.attendees ?? []`
in `writeActiveRecordingLock` (`:25`) and `attendees?: string[]` on the
`ActiveRecordingLock` interface (`:40`).

Swift reads it off the same lock file it already reads for `outputFile`. That will be
the **4th** hand-rolled copy of "read the lock JSON" in the MenuBar target
(`NotchPanelController:258`, `RecordingController:198/240/299`) — collapse them into
one `ActiveLock.read() -> [String: Any]?` helper while touching them anyway.

### 3.2 Ask AI — marker-file round trip
Mirrors the existing `retitle-request.json` handoff (`recorder.ts:332`
`applyPendingRetitle`, `cli.ts:685-710`): the short-lived CLI only drops a marker; the
live Recorder does the work on its existing 5s tick.

1. **`meet ask <sessionDir> <question>`** — validates the active lock exactly like
   `runRetitle` (`cli.ts:690-694`: no lock or `lock.sessionDir !== dir` → error, exit 1),
   then atomically writes `<sessionDir>/ask-request.json` = `{ id, question }`
   (`id` = fresh UUID, so a stale response can't be read as a fresh one). Nothing else.
2. `RecordingController.ask(question:) -> Bool` — mirrors `retitle(title:)` exactly:
   guards on live state, resolves the runner, spawns `meet ask` synchronously
   (`waitUntilExit()`), returns `terminationStatus == 0`.
3. `NotchPanelController` gets `var onAsk: ((String) -> Bool)?`, wired in `AppDelegate`
   next to the existing `setArmed` call (`AppDelegate.swift:27`) as one closure. The
   panel doesn't hold a `RecordingController` — it stays a lock-file reader.
4. `Recorder.applyPendingAskQuestion()`, called next to `applyPendingRetitle()`
   (`recorder.ts:577`):
   - **If `opencodeRunning` or `shuttingDown`: return and leave the marker in place** —
     next tick picks it up. Rev 1's "read it, delete it, run it" silently ate any
     question that arrived while the interactive `a` hotkey held the guard.
   - Otherwise: read + delete the marker, set `opencodeRunning = true`, and call
     `runOpencodeQuestion(config, outputFile, title, question)` **fire-and-forget** —
     the surrounding 5s status tick is synchronous (`applyPendingTags`/`applyPendingRetitle`
     both are) and must not be blocked for up to 60s.
   - On settle: `writeAtomic(<sessionDir>/ask-response.json, { id, answer })` or
     `{ id, error }`, then clear `opencodeRunning` in a `finally` (same shape as
     `askQuestion()` at `recorder.ts:632-677`).
5. The panel polls `ask-response.json` on its existing hover-only poll timer while a
   question of that `id` is outstanding — same timer, one branch (transcript tail vs.
   ask response). On a matching `id`: display, then delete the response marker.
   Non-matching `id` → ignore and delete (stale).

No new IPC layer — same file-based, single-owner-deletes convention as
`retitle-request.json` (`CLAUDE.md`, File-Based Communication).

### 3.3 Geometry — not "unchanged", contrary to Rev 1
- `buttonFrame(for:notchHeight:)` (`:237`) hardcodes one right-aligned button. It gains
  a slot index and lays out right-to-left, so the mode button sits left of "Раскрыть".
- `scrollFrame(for:notchHeight:)` (`:230`) gains a `bottomInset` so the ask input row
  can sit below the text view; `0` in transcript mode keeps today's layout byte-identical.
- Both are already pure static helpers covered by `selfCheckTailExtraction`'s harness —
  extend it rather than adding a test target.
- Collapsed width is the notch width (~200pt), so both buttons overlap during the 0.18s
  collapse animation. Accepted — they're invisible behind the physical cutout at that
  size; not worth a layout guard.

---

## 4. Files touched

| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/NotchPanelController.swift` | key-capable `NSPanel` subclass, mode button, ask input row, ask-response polling, attendee header line, hover-hide suppression, `buttonFrame` slot + `scrollFrame` bottom inset, shared lock reader |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | `ask(question:)` — mirrors `retitle(title:)` |
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | one line: wire `notchPanelController.onAsk` |
| `src/locks.ts` | `attendees` in `writeActiveRecordingLock` + on `ActiveRecordingLock` |
| `src/cli.ts` | `ask <sessionDir> <question>`, mirrors `retitle` incl. lock validation |
| `src/recorder.ts` | `applyPendingAskQuestion()` at line 577, shares `opencodeRunning` |

---

## 5. Testing

**Automated** (`src/recorder.test.ts` style, mock `runOpencodeQuestion`):
- `ask-request.json` in → `runOpencodeQuestion` called with `(config, outputFile, title, question)`
  → `ask-response.json` = `{ id, answer }`, marker deleted.
- Rejected path: `runOpencodeQuestion` throws → `{ id, error }` written, `opencodeRunning` cleared.
- **Guard path: marker present while `opencodeRunning` → nothing runs and the marker
  still exists** (the Rev 1 bug, pinned).

**Swift `--self-test-notch`** (extends `selfCheckTailExtraction`):
- Attendee header: non-empty list → `Участники: …` first line; empty → no line at all.
- `buttonFrame` slots 0 and 1 don't overlap at hover width; `scrollFrame` with a
  bottom inset stays inside the panel.

**Manual** (no headless way to assert `NSPanel` state):
- Calendar auto-start with attendees → header line lists them; manual Start → no line.
- Ask AI: field accepts keyboard input at all (the `canBecomeKey` fix); submit → answer
  within ~60s; ask again while the first runs → blocked.
- Type half a question, move the mouse off the panel → panel stays; clear the field,
  move away → panel collapses after 0.35s; Stop recording mid-question → panel disarms.
- Away and back mid-question → answer still lands; mode reset to Транскрипт after a
  full collapse, but re-entering Ask AI still shows the last answer.

---

## 6. Open questions / risks

- 60s opencode timeout in a panel that hides on ~350ms of no-hover: fine — the answer
  waits on disk (same "poll only while revealed" principle as the original spec).
- `meet ask` pays a synchronous Node cold start on the button click (same cost
  `setTags`/`retitle` already pay). Confirm it doesn't feel laggy before shipping;
  if it does, the fix is a detached spawn, not a new IPC channel.
- Forcing `bigFrame` on entering Ask AI is a guess at the right size — if the answer
  area feels cramped anyway, raise `bigHeightFraction` rather than adding a third frame.
- `ask-response.json` lives in `sessionDir`, which finalize deletes. A question
  answered after Stop is lost; not worth plumbing around for a hover panel.
