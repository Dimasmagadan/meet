# SPEC: Menu Bar — Auto-Focus Title Input + Tag Prompt on Stop

**Date:** 2026-08-03
**Status:** Draft
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Two small UX gaps in `Meet.app` (`native/MenuBar/`), reported after real usage:

1. **Title prompt has no keyboard focus.** Clicking "Start Recording" shows the title `NSAlert`, but the text field isn't focused — the user has to click into it before typing.
2. **No tagging opportunity on Stop.** Tags can only be added mid-meeting via "Add Tag…" (`SPEC_MIDMEETING_TAGS_2026-07-31.md`). Clicking Stop ends the recording with no chance to tag it — the only tagging window is a menu item the user has to remember to use *before* stopping.

Both are pure `native/MenuBar/Sources/MeetMenuBar/` changes. No TS pipeline change — problem 2 reuses the existing pending-tags inbox (`src/tags.ts`, already flushed synchronously in `Recorder.shutdown()` before finalize, see §3).

---

## 2. Problem 1 — Title input has no focus

### Root cause

`AppDelegate.promptTitle()` (`AppDelegate.swift:192-203`) and `promptTag()` (`:205-215`) both set:
```swift
alert.window.initialFirstResponder = input
```
This is correct for a normal foreground app, but `Meet.app` runs with `LSUIElement` / `NSApplication.Activation.Policy.accessory` (`main.swift`, per `SPEC_MENUBAR_UI_2026-07-30.md` §2.2) — it has no Dock icon and is never the "active app" in the traditional sense. Clicking a status-item menu item does **not** activate the app the way clicking a Dock icon does. `NSAlert.runModal()` still shows the window and makes it key, but without an explicit activation the field editor doesn't reliably pick up first-responder status — the window appears focused-looking but keystrokes don't route to the text field until the user clicks it.

`grep` confirms `NSApp.activate(ignoringOtherApps:)` is never called anywhere in `native/MenuBar/Sources/` — this is the missing piece, a well-known requirement for accessory-policy apps presenting modal panels.

### Fix

`promptTitle()` and `promptTag()` are already byte-similar 9-line copies, and §3 would add a third. Collapse all three into one helper so `NSApp.activate(ignoringOtherApps: true)` lands in exactly one place — three copies means three places for the next focus bug to hide:

```swift
private func promptText(message: String, info: String, ok: String, default def: String = "") -> String? {
    let alert = NSAlert()
    alert.messageText = message
    alert.informativeText = info
    let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    input.stringValue = def
    alert.accessoryView = input
    alert.addButton(withTitle: ok)
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    NSApp.activate(ignoringOtherApps: true)   // NEW — accessory apps need this before runModal
    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    return input.stringValue
}
```

`promptTitle()` and `promptTag()` are deleted; their call sites become:

```swift
// startRecording()
guard let title = promptText(message: "Start recording", info: "Meeting title", ok: "Start", default: defaultTitle) else { return }

// addTag()
guard let raw = promptText(message: "Add tag", info: "Tag name (comma-separated for multiple)", ok: "Add") else { return }
```

Net: −3 functions, +1. `showAlert()` stays as-is (no accessory view, no return value).

Deployment target is `.macOS(.v13)` (`native/MenuBar/Package.swift`), so `activate(ignoringOtherApps:)` compiles without a deprecation warning — Swift only warns when the deployment target is ≥ the deprecation version (14.0).

`input.selectText(nil)` is *not* needed — `stringValue` pre-fill + focus is enough; leaving the default title fully selected is a nice-to-have, not required by the report, so skipped.

### Testing
Manual only (no headless way to assert NSWindow first-responder in this repo's test setup): click "Start Recording" from the status item, type immediately without clicking — text lands in the field. Repeat for "Add Tag…" and the new stop prompt (§3).

---

## 3. Problem 2 — Tag prompt on Stop

### Design: prompt-then-signal, no backend change

The mid-meeting "Add Tag…" path already exists end-to-end: `RecordingController.addTag()` → spawns `meet tag <sessionDir> <tags>` → appends to `<sessionDir>/pending-tags.log` (`src/tags.ts:queuePendingTags`, append-only, `SPEC_MIDMEETING_TAGS_2026-07-31.md`). On the recorder side, `Recorder.shutdown()` calls `promptTags()`, which calls `applyPendingTags()` **first, before** finalizing (`src/recorder.ts:271-272`) — so any tag queued before the SIGINT that triggers shutdown is picked up, independent of the 5s poll tick.

The window is in fact wide, not tight: `shutdown()` `await`s `stopRecording()` (capture teardown + pipeline drain) *and* `summaryScheduler.flush()` before `promptTags()` ever runs — seconds, not milliseconds. Waiting on the spawn below is for determinism, not because the race is close.

So Stop just needs to ask for tags *before* sending the signal, reusing `addTag()` verbatim:

```
User clicks "Stop"
  → NSAlert: "Tags (optional, comma-separated)" + [Stop] [Cancel]
      Cancel  → do nothing (recording continues)
      Stop, empty field   → recordingController.stop()
      Stop, non-empty field → recordingController.addTag(text), THEN recordingController.stop()
```

### Ordering + failure-reporting fix in `addTag()`

`RecordingController.addTag()` currently fires the `meet tag` subprocess without waiting (`try? proc.run()`, `RecordingController.swift:115`) and swallows every failure. Two changes, both unconditional — no `waitUntilDone` flag:

```swift
@discardableResult
func addTag(_ raw: String) -> Bool {
    guard state == .recording || state == .paused else { return false }
    guard let runner = resolver.resolve(), let sessionDir = currentSessionDir() else { return false }
    let tags = raw.split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    guard !tags.isEmpty else { return true }   // nothing to queue is not a failure

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: runner.executable)
    proc.arguments = runner.args + ["tag", sessionDir] + tags
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    do {
        try proc.run()
        proc.waitUntilExit()   // NEW — the write must land before the stop flow's SIGINT
    } catch {
        return false
    }
    return proc.terminationStatus == 0
}
```

**Why always wait, no flag.** `runner` is `node <dist/main.js>` (`RunnerResolver`), so this is a full Node cold start + commander import to append a few bytes — realistically 150–400ms, not "a few ms". (Worse on the attach-to-existing-session path, where `resolver.resolve()` hasn't cached yet and synchronously spawns `meet bin-path` first — but that cost is already paid by today's `addTag`.) That's an invisible hitch right after a modal dismisses, in both call paths. A flag to make one caller 300ms faster isn't worth two behaviours of one function.

**Why report failure.** A resolver miss, a dead session lock, or a spawn error currently drops what the user typed with zero feedback. Mid-meeting that's recoverable — retype it. At stop it is not: the recording is over, there is no second chance. `stopRecording()` surfaces it via the existing `showAlert` and stops anyway (never trap the user in a recording they asked to end).

### `AppDelegate` changes

```swift
@objc func stopRecording() {
    guard let tags = promptText(message: "Stop recording", info: "Tags (optional, comma-separated)", ok: "Stop") else { return }
    if !recordingController.addTag(tags) {
        showAlert(title: "Tags not saved", message: "Meet could not queue \"\(tags)\" for this recording. Stopping anyway.")
    }
    recordingController.stop()
}
```
No `promptStopTags()` — §2's `promptText` helper covers it. No `if !tags.isEmpty` guard either: `addTag` already splits/trims/filters and returns `true` on an empty result, so empty-field Stop is a plain no-op. `addTag()`'s menu item (`AppDelegate.swift:145-148`) ignores the new return value via `@discardableResult` and is otherwise untouched.

### Non-goals
- No tag *removal* here either — same as `SPEC_MIDMEETING_TAGS`, add-only.
- No change to the CLI's own stop-time TTY picker (`Recorder.promptTags()` interactive branch) — headless recordings (all menu-bar recordings) never hit it; this is exactly the gap `SPEC_MIDMEETING_TAGS` left open for the menu bar and this closes it.
- Not blocking Stop on the tag dialog being *required* — Cancel must still allow "I don't want to tag, just let me stop" via leaving the field empty, not force a cancel-vs-stop dilemma. (Two separate escape hatches: empty+Stop = stop untagged, Cancel = don't stop at all.)
- **Quit does not prompt.** `quitApp()` → `recordingController.quit()` → `stop()` bypasses this dialog by design — quitting is not a "wrap up my meeting" gesture. Same for auto-stop (max duration / no-text timeout) and a terminal-side `q`, which never reach `AppDelegate` at all. Do not "fix" these later without a new report.
- No direct Swift write to `pending-tags.log`. It would delete the spawn, the wait and the failure path, but it duplicates the inbox file format across the language boundary; the repo's Node↔Swift contract is process + JSON (see `CLAUDE.md`). Reusing `meet tag` is deliberate.

### Testing
Manual end-to-end: Start a recording, click Stop, type `standup, followup`, click Stop button → `cat <sessionDir_or_finalized_meta.md>` shows `Tags: standup, followup`. Repeat with empty field → no `Tags:` regression (still writes `meta.md`, per existing `writeMetaFile` behavior). Click Cancel → recording still running (state stays `.recording`, verify via status item).

No new TS/unit surface — this is 100% reuse of `SPEC_MIDMEETING_TAGS_2026-07-31.md`'s already-tested `queuePendingTags`/`drainPendingTags`/`applyPendingTags`.

---

## 4. Files touched

| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | `promptTitle()` + `promptTag()` deleted, replaced by one `promptText(message:info:ok:default:)` that calls `NSApp.activate(ignoringOtherApps:)`; `stopRecording()` prompts for tags, alerts on queue failure, then stops |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | `addTag()` — `waitUntilExit()` on the spawned `meet tag`, `@discardableResult Bool` return |

No changes to `src/`, `RunnerResolver.swift`, `Package.swift`, or any TS test file.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| `waitUntilExit()` on main thread stalls the UI if `meet tag` hangs (e.g. resolver misconfigured) | Same failure mode as every other `RecordingController` spawn in this codebase (`start()` itself blocks on `proc.run()` errors synchronously, `RunnerResolver` already does a blocking `waitUntilExit` on `meet bin-path`); `meet tag` does a single `appendFile` and exits — not a new class of risk. Cost is one Node cold start, ~150–400ms, once per Stop |
| Recording ends *while* the stop dialog is open (auto-stop at max duration, or terminal-side stop) | Timers don't fire in the modal run-loop mode, so `state` still reads `.recording`, but `currentSessionDir()` returns nil once the lock is gone → `addTag` returns `false` → user gets the "Tags not saved" alert instead of a silent drop. `stop()`'s subsequent SIGINT to a reaped PID is pre-existing behaviour (and a pre-existing PID-reuse hazard), unchanged by this spec |
| Escape now aborts a Stop | Escape maps to the second button (Cancel), so Stop is no longer one-click-and-done. Accepted: that's the point of a confirm step, and the recording is still running afterwards — visible in the status item |
| User expects tag prompt to also appear for `Pause`/`Extend` | Out of scope — only requested for Stop |
| `NSApp.activate(ignoringOtherApps:)` steals focus from whatever app the user was in | Same as any status-item-triggered modal; already implicitly expected since the alert takes keyboard input regardless — this just makes the existing modal *actually* modal-for-typing instead of visually-modal-but-unfocused |
