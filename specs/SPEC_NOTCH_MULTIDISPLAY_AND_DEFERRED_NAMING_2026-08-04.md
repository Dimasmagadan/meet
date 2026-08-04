# SPEC: Notch Panel on Any Display + Deferred Meeting Naming

**Date:** 2026-08-04
**Status:** Draft — pre-implementation
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Two independent fixes to `native/MenuBar/` (`Meet.app`), bundled here because both were reported together:

1. **Notch panel doesn't appear when the app is driven from a non-notch screen.** The hover panel (`SPEC_NOTCH_TRANSCRIPT_PANEL_2026-08-03.md`) should always live on the physical notch display, regardless of which screen the user is focused on when they start/stop recording.
2. **"Start Recording" blocks on a naming dialog before any capture begins.** Recording should start the instant the user clicks Start; the meeting title becomes an editable label on an already-running recording, not a precondition for starting one.

---

## 2. Fix 1 — notch panel on the wrong screen

### Root cause

`NotchPanelController.arm()` (`NotchPanelController.swift:47`):

```swift
guard let screen = NSScreen.main, let notch = Self.notchRect(on: screen) else { return }
```

`NSScreen.main` is *"the screen containing the window that currently receives keyboard events"* — i.e. wherever the user's focus is, not the physical notch display. If the user starts a recording while focused on an external monitor (notch MacBook used as a secondary/lid-open-elsewhere setup), `NSScreen.main` resolves to the external screen, `notchRect(on:)` returns `nil`, and `arm()` bails silently. The panel never appears for the rest of that recording — `arm()` is edge-triggered (`setArmed` only calls it on the idle→recording transition), so switching focus back to the notch screen afterward doesn't retrigger it either.

### Fix

Stop asking "does the focused screen have a notch" and instead ask "which screen has a notch" — scan `NSScreen.screens` once per `arm()`:

```swift
static func notchScreen() -> NSScreen? {
    NSScreen.screens.first { notchRect(on: $0) != nil }
}
```

`arm()` uses `Self.notchScreen()` in place of `NSScreen.main`. No notch display present anywhere (external-only setup, older MacBook) → `nil`, same silent-no-op as today. This is the entire fix — one function, one call-site swap. Geometry stays recomputed only on `arm()` (unchanged scope decision from the original notch-panel spec; no `didChangeScreenParameters` observer).

The whole `screen` binding must be replaced, not just the notch lookup: `arm()` also reads `screen.frame.height` for `bigFrame` (`NotchPanelController.swift:59`). Sizing the big-expanded panel off the *focused* screen while anchoring it to the *notch* screen would put a 50%-of-external-height panel on a 14" laptop display.

### Non-goals

- No support for hot-plugging a second notch-capable display mid-recording (recompute happens on the next `arm()`, i.e. next recording).
- No change to *where the status-item menu itself* appears — that's an AppKit/System Settings concern (`Displays have separate menu bars`), out of scope.

### Testing (manual — no headless way to assert `NSScreen`/`NSPanel` state)

- Notch MacBook + external monitor, external set as active/focused (mouse + keyboard there) → Start Recording → hover the *notch* screen → panel reveals.
- Same setup, but focus never touches the notch screen for the whole recording → panel still works when the user does eventually move the mouse there.
- Single notch-only display (today's working case) → unaffected, still works.
- External-only display as the sole screen (clamshell or old MacBook) → feature stays inactive, no crash.

---

## 3. Fix 2 — deferred meeting naming

### Root cause

Two things currently gate recording on a title:

- **CLI**: `meet start <title>` — `title` is a required positional argument (`cli.ts:39`); `startSession()` computes `meetingDir`/`outputFile` from it and creates the folder (`cli.ts:245-251`) before the `Recorder` (and therefore `AudioCapture`) is even constructed.
- **Menubar**: `AppDelegate.startRecording()` (`AppDelegate.swift:102-104`) calls the blocking `promptText()` (`NSAlert.runModal()`) and only calls `recordingController.start(title:)` — which spawns the `meet start` process — *after* the user dismisses it. Cancelling aborts the recording entirely (`guard let title = promptText(...) else { return }`).

Net effect: zero audio capture happens until the dialog is answered.

### Target behavior

1. Clicking **Start Recording** starts capture immediately — no blocking dialog in the way.
2. Recording always begins under the default title `"meeting"` — this is not a new concept, it's the exact default `cli.ts:201` already uses for the interactive "next meeting" loop (and the exact fallback `AppDelegate.swift:103` already uses to prefill the old dialog). Folder: `~/Meetings/<timestamp>-meeting/`.
3. The naming dialog still appears, but *after* the process is already spawned and recording, and it no longer gates anything — Cancel just leaves the title as `"meeting"`.
4. A new **"Rename Meeting…"** menu item (visible while `.recording`/`.paused`) lets the user (re)name the meeting at any point. This is what covers "if I don't set a name for 3–5 minutes" — no timer needed, the default is already live from second one, and renaming is always one menu click away.
5. Renaming while live **moves the already-created meeting folder** in place (`~/Meetings/<ts>-meeting/` → `~/Meetings/<ts>-<new-slug>/`) and repoints everything that references it, so the live transcript, notch panel, and any tags/notes already written aren't lost or orphaned.

Rejected alternative: writing to a genuinely separate temp area outside `~/Meetings` until a real title exists, then creating the meeting folder from scratch. Rejected because `getOutputDir()` already produces a real, well-formed folder name for the `"meeting"` default — there's no reason to invent a second staging location when a plain directory rename does the same job with less code and less state to reconcile later.

### Mechanics

**`meet start` — optional title.** `.argument("<title>", ...)` → `.argument("[title]", ...)`; action handler passes `title ?? "meeting"` into `startSessionLoop`. No other change to `startSession()` — it already treats title as a plain string.

**Live rename.** New CLI command `meet retitle <sessionDir> <newTitle>` (name picked to avoid clashing with the existing post-finalize `meet rename <meetingDir> <speakerId> <newName>` in `speaker-rename.ts`). Spawned synchronously by the menubar exactly like `RecordingController.setTags()` spawns `meet tag` today. It:

- Reads `active-recording.lock` and **verifies `lock.sessionDir === <sessionDir>`**, exiting non-zero otherwise. Without this, retitling a stale/finished session's dir would drive the *live* recorder to a folder computed from the wrong session's `startedAt`. `readActiveRecordingLock()` (`locks.ts:49`) already validates pid liveness, so this also covers "no recording is running".
- Reads `session.json` from `sessionDir` for `startedAt` and the current `outputFile`.
- Computes the new folder/file via the existing `getOutputDir`/`getOutputPath` (`storage.ts:98-107`) — same slugging logic already used at start.
- If the new path equals the current one (renaming to the same slug), no-op, exit 0.
- Writes a marker into `sessionDir`: `retitle-request.json: { title, newOutputDir }`.

The live `Recorder` process is the only thing that can safely rename its own output folder without racing its own writes, so the actual move happens there, not in the short-lived `retitle` CLI invocation.

**Handoff: the existing 5s poll, not a signal.** `startStatus()`'s `setInterval` (`recorder.ts:467-519`) already calls `applyPendingTags()` every 5 seconds — which is *exactly* this problem, already solved: the menubar spawns a short-lived CLI that drops a state file into `sessionDir`, and the live recorder picks it up on its next tick. `startStatus()` is called unconditionally from `setupSignalHandlers()` (`recorder.ts:664`), so it runs in headless (menubar) mode too, where stdout is `nullDevice`. A sibling `applyPendingRetitle()` on the same tick needs no new signal, no new handler, and no `cleanup()` change. ≤5s latency on a *cosmetic folder name* is invisible — the transcript never stops being written either way.

Rejected: `SIGHUP` + signal handler. It's the one POSIX signal `Recorder` doesn't already use (`SIGINT`/`SIGTERM`/`SIGUSR1`/`SIGUSR2`/`SIGWINCH` are all taken — `recorder.ts:622-639`) and it would work, but it buys ~5s of latency at the cost of a third mechanism for the same menubar→recorder handoff, plus a matching `cleanup()` teardown (`recorder.ts:243-261` removes every other handler) that's easy to forget. Signals earn their keep for pause/resume/extend, which must be instant; a folder rename doesn't.

`applyPendingRetitle()` then:

- `fs.renameSync(oldMeetingDir, newMeetingDir)` — same volume (`~/Meetings` → `~/Meetings`), so it's a metadata-only rename, not a copy, and **everything already on disk comes along for free**: `transcript.md`, `summary.md` if enabled. (`meta.md` is only written at shutdown via `writeMetaFile()` from `dirname(session.outputFile)` (`recorder.ts:303`, `tags.ts:45-46`), so it lands in the renamed folder by construction — there is no mid-call `meta.md` to move. Tags themselves live in `sessionDir/tags-state.json` and never move at all.)
- **Wrapped in `try/catch`.** `renameSync` onto an existing non-empty directory throws `ENOTEMPTY`/`EEXIST` — reachable whenever two meetings in the same wall-clock minute slug identically, since the folder name is `YYYY-MM-DD_HH-MM-<slug>`. An uncaught throw here kills the live recording, i.e. loses the meeting, over a cosmetic rename. On failure: `this.warn(...)`, delete the marker, keep recording under the old path. Belt-and-braces `existsSync(newMeetingDir)` pre-check keeps the common case out of the catch.
- Updates `session.title` and `session.outputFile` in memory (today `outputFile` is cached as a `readonly` field on `Recorder` at construction (`recorder.ts:42`, `:60`) — this must become mutable, since `appendEntry(this.outputFile, entry)` (`recorder.ts:121`) has to target the new path starting with the very next chunk).
- **Repoints `summaryScheduler`.** Same bug class as `readonly outputFile`, one layer down: `SummaryScheduler` is constructed with `outputFile: summaryOutputPath(session)` (`recorder.ts:66`) — a *string snapshot*, not a getter. After a rename it keeps writing to the old absolute path, and `writeAtomic()` (`storage.ts:58`) does no `mkdir`, so every subsequent summary write fails ENOENT into the scheduler's fail-open warn and `summary.md` silently stops updating. The scheduler needs its path refreshed (or the field changed to a `() => string`). Note `formatSummaryStatusSuffix()` (`recorder.ts:531`) already calls `summaryOutputPath(this.session)` live, so leaving the scheduler stale also makes the status line disagree with reality.
- Persists `session.json` and re-writes `active-recording.lock` (`writeActiveRecordingLock`), so the notch panel and any other lock reader pick up the new path on their next poll.
- Deletes the marker file.

**Transcript header.** `transcript.md` opens with `makeHeader(title, ...)` → `# meeting — 04.08.2026 15:20` (`cli.ts:250`, `assembler.ts:44`), written once at start. A rename does not patch it, so the live file keeps the old title in its header. Accepted, not fixed: `finalize.ts:592` calls `rewriteMarkdown(session.outputFile, session.title, ...)`, which regenerates the header from the (now updated) `session.title`, so this self-heals at finalize. The stale header is visible only mid-recording, and the notch panel already drops header lines (`tailLines` keeps only `**[`-prefixed lines).

**What never moves:** raw WAV chunks, `entries.jsonl`, and `session.json` all live in `sessionDir` (`~/.meet/sessions/meet-{id}/`), keyed by session id, never by title — that's already the durable "working area" and is completely untouched by any of this.

### Menubar changes

- `AppDelegate.startRecording()`: drop *only* the `guard let title = promptText(...) else { return }` gate, then call `recordingController.start(title: "meeting")`. The naming prompt (still `promptText`, still modal to the *menubar app's own UI*) runs after the spawn; a real, non-default title submitted here calls a new `recordingController.retitle(title:)`. Cancel → no-op, stays `"meeting"`.
- **The mic TCC preflight stays exactly where it is.** `startRecording()` currently awaits `permission.ensureMic()` inside `Task { @MainActor in ... }` and bails to a System Settings deep-link on deny (`AppDelegate.swift:105-129`); `start()` is called from inside that task. "Start immediately" in §3 means *ahead of the title prompt*, not ahead of the permission gate — spawning `meet start` without mic access produces a recording that captures nothing. `ensureMic()` is a no-op after the first grant, so the steady-state path is still one click → recording. The `@MainActor` pin and its comment are load-bearing (Timers must schedule on the main RunLoop) and must survive the edit.
- New **"Rename Meeting…"** item in the `.recording` and `.paused` menus, reusing the same prompt + `retitle(title:)` call, so the user isn't limited to the one prompt right after Start.
- `RecordingController.retitle(title:)`: mirrors `setTags()` — guards on `state == .recording || .paused`, resolves `sessionDir` via `currentSessionDir()` from the lock, spawns `meet retitle <sessionDir> <title>`, waits for exit (`proc.waitUntilExit()`), returns `terminationStatus == 0`.
- `saveLastTitle()` **is** affected: its only call site today is inside the deleted guard (`AppDelegate.swift:106`, right after `promptText` returns). It moves to the retitle path — save the title whenever the user actually submits a real one, from either the post-start prompt or "Rename Meeting…". Otherwise `lastTitle()` freezes at whatever was typed before this change shipped. `lastTitle()` itself keeps prefilling both prompts.

### Files touched

| File | Change |
|---|---|
| `src/cli.ts` | `start`'s `<title>` → `[title]`, default `"meeting"`; new `retitle` command (validates lock, writes marker) |
| `src/recorder.ts` | `outputFile`/`session.title` become mutable; `summaryScheduler` path repointable; new `applyPendingRetitle()` on the existing 5s status tick, doing the guarded folder rename + `session.json`/lock persistence |
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | non-blocking start flow (mic preflight retained); `saveLastTitle()` moves to the retitle path; new "Rename Meeting…" menu item |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | new `retitle(title:)` method |
| `native/MenuBar/Sources/MeetMenuBar/NotchPanelController.swift` | Fix 1 (§2) — one function |

### Testing

- Click Start Recording with no further interaction → transcript.md appears under `.../-meeting/` within one chunk, no dialog blocked anything.
- Submit a real title in the initial prompt → folder renamed on disk within ~5s of submitting; transcript continues at the new path with no lost entries either side of the move.
- Use "Rename Meeting…" mid-call, after tags have already been added, then Stop → `transcript.md` and (shutdown-written) `meta.md` both end up in the renamed folder, `meta.md` carrying the new title.
- With `summaryEnabled`, rename mid-call and wait for the next summary interval → `summary.md` keeps updating **in the renamed folder** (regression guard for the cached `SummaryScheduler` path), and no `summary.md` reappears at the old path.
- Rename twice in one recording → second rename moves from the *first* renamed folder, not the original.
- Rename to a title that slugs identically to the current one → no-op, no error.
- Rename onto a colliding existing folder (start two meetings in the same minute, retitle the second to the first's title) → recording survives, warns, keeps the old path. **Must not crash the recorder.**
- `meet retitle <someOtherSessionDir> X` while a different session is live → non-zero exit, live recording untouched.
- Notch panel (Fix 1) kept pointed at the live file across a rename — hover during/right after a rename shows continuous content, not a gap.
- Cancel the initial naming prompt → recording keeps running under `"meeting"`, "Rename Meeting…" still available later.

### Open questions / accepted risk

- **Crash mid-rename**: `fs.renameSync` is a single atomic syscall, but the marker file + `session.json` update around it are not transactionally tied to it. A crash between the rename and the `session.json` write would leave `session.json` pointing at the pre-rename path while the folder has already moved. Not solved here — flagged as a known gap, consistent with existing "durable but not transactional" session-state philosophy (`CLAUDE.md` — crash resumes from `session.json`, doesn't roll back partial writes). Revisit if it's ever actually hit.
- **In-flight append during a rename**: `appendEntry()` in the transcribe callback is fire-and-forget (`.catch()`, not awaited) — a rename landing in the same tick as an in-flight `appendFile` isn't strictly serialized against it. Benign in the worst case: the open fd follows the moved inode, so the line lands in the renamed file, not a resurrected old one. Accepted rather than building a write queue for it.
