# Code Review: `68df7cd` — menu bar app, Raycast script, signal-based control

**Reviewed:** 2026-06-18
**Commit:** `68df7cd feat: add menu bar app, Raycast script, and signal-based control`
**Files:** `AGENTS.md`, `native/MenuBar/**`, `raycast/start-meeting.sh`, `src/cli.ts`, `src/recorder.ts`

Verified on-machine: macOS signal numbers (`kill -l 30` → `USR1`), Node signal constants, and node binary location.

---

## 🔴 Critical — "Extend +15m" is broken and silently pauses instead

`native/MenuBar/Sources/MeetMenuBar/RecordingController.swift:77`
```swift
func extend() {
    guard let pid = attachedPid else { return }
    sendSignal(30, to: pid) // SIGUSR3
}
```

On macOS **signal 30 *is* `SIGUSR1`** (`kill -l 30` → `USR1`; Node `os.constants.signals.SIGUSR1 === 30`). There is no `SIGUSR3` on Darwin — `os.constants.signals.SIGUSR3` is `undefined`.

Consequences:
- Swift's `extend()` sends signal 30 → the recorder's `process.on("SIGUSR1")` fires → **`togglePause()` runs**. "Extend +15m" toggles pause/resume instead of extending the cap.
- `src/recorder.ts:516` `process.on("SIGUSR3", …)` registers without throwing (Node accepts the name) but is **dead code** — no real signal maps to it, so `extendCap()` is unreachable from the menu bar.

**Fix:** pick a real free signal (e.g. `SIGWINCH`, `SIGINFO`, or `SIGHUP`). Send it from Swift and register `process.on("SIGWINCH", () => this.extendCap())` in Node.

---

## 🔴 Critical — hardcoded node path doesn't exist on Apple Silicon

`native/MenuBar/Sources/MeetMenuBar/RecordingController.swift:31`
```swift
proc.executableURL = URL(fileURLWithPath: "/usr/local/bin/node")
```

This is the Intel-Homebrew path. On Apple Silicon node lives at `/opt/homebrew/bin/node`; `/usr/local/bin/node` does not exist. `proc.run()` throws, the `print(...)` goes to the menu bar app's own (invisible) stdout, and **"Start Recording" silently does nothing**. The project is documented as Apple Silicon only, so this is the default-broken path.

**Fix:** resolve via `/usr/bin/env node`, read `which node`, or make it configurable.

---

## 🟠 Bug — Stop is a no-op for attached sessions

`native/MenuBar/Sources/MeetMenuBar/RecordingController.swift:70`
```swift
func stop() {
    guard let proc = process, proc.isRunning else { return }   // nil for attached sessions
    sendSignal(SIGINT, to: proc.processIdentifier)
}
```

`stop()` guards on `process`, but `attachToExistingSession()` only sets `attachedPid` (leaving `process == nil`). So when the app discovers a session it didn't spawn (the whole point of `SessionMonitor`), **Stop does nothing** — while Pause/Resume/Extend work because they use `attachedPid`.

**Fix:** fall back to `attachedPid` and `kill(pid, SIGINT)`.

---

## 🟠 Design — SIGUSR1 and SIGUSR2 both just toggle

`src/recorder.ts:514-515`
```ts
process.on("SIGUSR1", () => { void this.togglePause(); });
process.on("SIGUSR2", () => { void this.togglePause(); });
```

Swift treats SIGUSR1 as pause and SIGUSR2 as resume, but Node toggles on both. It only works while the two processes' states stay perfectly in lockstep. Any missed/duplicate signal desyncs them, after which "Pause" can resume and vice-versa.

**Fix:** make them explicit — `SIGUSR1` → pause if recording, `SIGUSR2` → resume if paused — so they're idempotent and self-correcting.

---

## 🟡 Minor

- **Dock icon:** the SwiftPM executable has no `Info.plist`/`LSUIElement` and never calls `NSApp.setActivationPolicy(.accessory)`, so a menu-bar-only app shows a Dock icon and app-switcher entry.
- **Hardcoded `~/www/repos/meet/dist/main.js`** in both `meetBin` and the Raycast script — fine for a personal tool, but worth a constant/config.
- **`session.json` write in `togglePause` (`src/recorder.ts:443`)** can interleave with the pipeline's own writes. It's `writeAtomic` (no torn reads) and likely the same in-memory object, so low risk — just noting the shared-writer pattern.
- The 1s timer rebuilds the entire `NSMenu` every tick to refresh the elapsed label; harmless but wasteful (menu is only visible on click).

---

## ✅ Good

- `--headless` correctly gates both stdin raw mode and the tag picker.
- `isPidAlive` via `kill(pid, 0)` matches the Node `locks.ts` convention.
- `terminationHandler` + lock-file polling cover both self-spawned and externally-ended sessions.

---

## Bottom line

The two 🔴 items mean neither **Start** nor **Extend** works from the menu bar on Apple Silicon as committed.
