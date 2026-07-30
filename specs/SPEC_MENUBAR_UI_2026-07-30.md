# SPEC: Menu Bar UI App (productionize `native/MenuBar/`)

**Date:** 2026-07-30
**Status:** Draft — codebase-verified; Phase 2 (TCC) pending a spike
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Turn the existing `native/MenuBar/` Swift menu-bar prototype into a **production `.app` bundle**. This is the **foundation** (Phase 0) for two later features built *inside* the same app: scheduled auto-start (п.2) and calendar-driven auto-start (п.3). Those are deliberately left as outlines here — they depend on this app existing as a signed, always-running bundle.

This spec is the answer to three brainstormed ideas:
- **п.1** UI app instead of the terminal — *this spec* (the bulk of the work).
- **п.2** auto-start by schedule — outline only (§7); built on top of this app.
- **п.3** auto-start by calendar — outline only (§7); built on top of this app.

All three converge on one prerequisite: a bundled, signed, always-running menu-bar `.app`. Bare launchd agents cannot get reliable Microphone/Screen-Recording TCC prompts (no Aqua session / responsible process), so п.2 and п.3 must live *inside* the app rather than as standalone launchd jobs.

### Decisions (locked)
| Decision | Choice | Why |
|---|---|---|
| Capture architecture | **Shell-out**: app spawns `meet start --headless`, controls via POSIX signals | TS pipeline stays intact; minimal work; no audio-logic duplication in Swift |
| Base | **Build on `native/MenuBar/`** (do not rewrite) | ~70% done: status item, headless spawn, signal control, lock-file attach |
| First scenario | **п.1 UI** before п.2/п.3 | п.2/п.3 live as features *inside* this app; a bare launchd agent can't get reliable TCC prompts (no Aqua session) |
| Build system | **Stay SwiftPM** + bundling script (no Xcode project) | Repo is SwiftPM-pure (both `AudioCapture` and `MenuBar` use `Package.swift`) |
| Signing (v1) | **Ad-hoc** (`codesign -s -`) | Sufficient for personal use + reliable TCC; Team ID deferred to a distribution spec |

### Current state (verified)
- `native/MenuBar/Package.swift:6` targets macOS 13 — `SMAppService` (needs 13+) is available.
- `main.swift:6` calls `app.run()` with **no** `setActivationPolicy(.accessory)` → Dock icon shows.
- No `Info.plist` anywhere (glob empty) → not a real bundle; `swift build` yields a bare Mach-O.
- `RecordingController.swift:24` hardcodes `meetBin = "$HOME/www/repos/meet/dist/main.js"`.
- Start always passes the literal title `"meeting"` (`RecordingController.swift:42`).
- No `SMAppService` / Login-Item code (grep empty).
- Existing seams that make this cheap: `--headless` flag (`cli.ts:44`), `active-recording.lock` + `isActiveRecording()` (`locks.ts:60-62`), signal control (`SIGINT` / `SIGUSR1` / `SIGUSR2` / `SIGWINCH`), `SessionMonitor` attaching to CLI-started sessions.

### Goals
- `Meet.app`: no Dock icon, lives in menu bar, launches `meet` headless, reliably prompts for Mic + Screen Recording.
- Launch-at-login via `SMAppService`, so the app (and thus future scheduler/calendar) survives reboots.
- No hardcoded paths; survives `npm link`, repo moves, global installs.

### Non-goals (v1)
- No embedding of audio capture in the app (shell-out only).
- No scheduler, no EventKit, no `meet schedule` commands (those are п.2/п.3 — outlined in §7).
- No transcript/status rendering inside the app menu (optional polish — §6 outline).
- No Team-ID signing / notarization / distribution (separate spec).

---

## 2. Architecture

### 2.1 Runtime model
```
Meet.app (menu bar, always running if Login Item)
  └─ on Start: spawn  node dist/main.js start "<title>" --headless
       └─ meet writes active-recording.lock (pid = node process)
  └─ controls via POSIX signals to that pid:
       SIGINT=stop  SIGUSR1=pause  SIGUSR2=resume  SIGWINCH=extend+15m
  └─ SessionMonitor polls active-recording.lock every 5s → detects stop, also
     attaches to sessions started from the CLI
```
The `meet` headless process spawns `AudioCapture` (Swift) internally; **TCC grants for Mic/Screen land on `AudioCapture` / `node`**, with `Meet.app` as the responsible process. Phase 2 verifies this prompt path is reliable.

### 2.2 Files touched
| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/main.swift` | add `app.setActivationPolicy(.accessory)` |
| `native/MenuBar/Info.plist` | **new** — `LSUIElement`, bundle id, usage strings |
| `native/MenuBar/scripts/build-app.sh` | **new** — `swift build` → assemble `.app` → `codesign` |
| `native/MenuBar/Sources/MeetMenuBar/RunnerResolver.swift` | **new** — resolve `node` + `meet` paths (Phase 1) |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | drop hardcoded `meetBin`; use resolver; accept `title` param |
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | title prompt; Login-Item menu toggle (Phase 3) |
| `native/MenuBar/Sources/MeetMenuBar/LoginItemController.swift` | **new** — `SMAppService` wrapper (Phase 3) |
| `src/cli.ts` | new `meet bin-path` subcommand (Phase 1) |
| `src/types.ts` | optional `menuBarMeetBin` config override |

No change to the transcription pipeline, locks, or finalize path.

---

## 3. Implementation plan

> **Phases 0, 1, 3 are detailed (fully clear).** Phase 2 (TCC) and Phase 4 (polish) are **outlines** (§5/§6) — they depend on a spike and on appetite respectively. п.2/п.3 are outlines in §7.

### Phase 0 — `.app` bundle + ad-hoc signing  *(detailed — clear, blocking first)*

**Goal:** `swift build` output wrapped into a signed, Dock-less `Meet.app` that prompts TCC. This is also the **vehicle for the Phase 2 spike**.

**0.1 `Info.plist`** (`native/MenuBar/Info.plist`):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Meet</string>
  <key>CFBundleIdentifier</key><string>com.dimasmagadan.meet.menubar</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>MeetMenuBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>                       <!-- no Dock icon -->
  <key>NSMicrophoneUsageDescription</key>
  <string>Meet records meetings locally and needs microphone access.</string>
  <key>NSScreenCaptureDescription</key>
  <string>Meet captures system audio (other participants) via ScreenCaptureKit.</string>
</dict></plist>
```

**0.2 `main.swift`** — add belt-and-suspenders activation policy (so running the bare binary outside a bundle still hides the Dock):
```swift
let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // NEW
let delegate = AppDelegate()
app.delegate = delegate
app.run()
```

**0.3 Bundling script** (`native/MenuBar/scripts/build-app.sh`):
```sh
#!/bin/sh
set -e
cd "$(dirname "$0")/.."          # native/MenuBar
swift build -c release
APP="$PWD/.build/Meet.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/MeetMenuBar "$APP/Contents/MacOS/MeetMenuBar"
cp Info.plist "$APP/Contents/Info.plist"
# optional icon later: cp Meet.icns "$APP/Contents/Resources/"
codesign --force --sign - "$APP"   # ad-hoc
echo "Built: $APP"
```
`--deep` not needed (no embedded frameworks). Ad-hoc signature is stable per-binary-path; TCC grants persist for this bundle path.

**0.4 First-run:** open `Meet.app` from Finder / `open` (NOT the raw binary) so LaunchServices registers it as a bundle. macOS then attributes spawned children's TCC prompts to the app.

**Checkpoint:** `open .build/Meet.app` → status item appears, **no Dock icon**, clicking Start launches `meet` headless (still hardcoded title/path for now), mic+screen prompts appear.

---

### Phase 1 — Drop hardcodes, make title configurable  *(detailed — clear)*

**Goal:** no hardcoded paths; user picks a title.

**1.1 Path resolution — keep config logic in TS, not Swift.** Add a `meet bin-path` subcommand that prints the resolved runner as JSON:
```
$ meet bin-path
{"node":"/opt/homebrew/bin/node","main":"/Users/…/dist/main.js","meet":"/opt/homebrew/bin/meet"}
```
Resolution order in `src/cli.ts` (new helper, ~15 lines): `menuBarMeetBin` config override → `which meet` (global / `npm link` install) → repo `dist/main.js` + `which node`. `node` always via `which node` with `/opt/homebrew/bin/node` fallback.

**1.2 New `RunnerResolver.swift`** (replaces the inline `which node` block at `RecordingController.swift:30-38` and the hardcoded `meetBin` at `:22-25`):
```swift
struct Runner { let executable: String; let args: [String] }  // e.g. node + [main.js, start, …]
final class RunnerResolver {
    func resolve() -> Runner?           // shelling out to `meet bin-path` once, cached
}
```
- Called once at app launch, cached in `RecordingController`. On failure, shows an `NSAlert` ("meet not found — run `meet setup`") instead of silently doing nothing (current behavior at `RecordingController.swift:48-51`).
- **Config override** (`menuBarMeetBin` in `src/types.ts` `Config` + `DEFAULT_CONFIG`) is an escape hatch for unusual installs; documented but optional in v1.

**1.3 Title input.** Replace the literal `"meeting"` (`RecordingController.swift:42`) with a modal prompt before Start:
```swift
func promptTitle(default: String) -> String? {
    let alert = NSAlert()
    alert.messageText = "Start recording"
    alert.informativeText = "Meeting title"
    let input = NSTextField(frame: NSRect(x:0,y:0,width:260,height:24))
    input.stringValue = default
    alert.accessoryView = input
    alert.addButton(withTitle: "Start"); alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    return alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil
}
```
- Default = last-used title, persisted to `UserDefaults` (simplest) or `~/.meet/config.json` `menuBarLastTitle`. Empty string → fall back to `"meeting"`.
- Pass the resolved title through `start(title:)` → `proc.arguments = [main, "start", title, "--headless"]`.

**Checkpoint:** Start prompts for a title; `transcript.md` header shows that title; app survives moving the repo or `npm link`-ing `meet`.

---

### Phase 3 — Launch at Login (`SMAppService`)  *(detailed — clear, run after Phase 0/1)*

**Goal:** the app auto-starts on login so the future scheduler/calendar survive reboots.

**3.1 Service wrapper** (`LoginItemController.swift`, new):
```swift
import ServiceManagement
final class LoginItemController {
    private let service = SMAppService.mainApp
    var isEnabled: Bool { service.status == .enabled || service.status == .requiresApproval }
    func enable() throws  { try service.register() }
    func disable() throws { try service.unregister() }
}
```
- `SMAppService.mainApp` (macOS 13+) replaces the deprecated `SMLoginItemSetEnabled`. Requires the app to be a **bundled, signed** app — hence Phase 0 is a hard prerequisite.
- Statuses to handle: `.enabled`, `.notRegistered`, `.requiresApproval` (user toggled off in System Settings — re-register), `.notFound`.

**3.2 Menu toggle** in `AppDelegate`:
```swift
let item = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
item.state = loginItem.isEnabled ? .on : .off
// …
@objc func toggleLogin() {
    do { _ = loginItem.isEnabled ? try loginItem.disable() : try loginItem.enable() }
    catch { /* NSAlert: "Open System Settings → General → Login Items" deep-link */ }
    rebuildMenu()
}
```

**3.3 `Package.swift`** — `ServiceManagement` is a **system framework**, not a SwiftPM package; link it explicitly:
```swift
.executableTarget(
    name: "MeetMenuBar",
    dependencies: [],
    linkerSettings: [.linkedFramework("ServiceManagement")]
)
```

**Checkpoint:** toggle "Launch at Login" on → log out/in → app relaunches in menu bar.

---

## 4. Testing

| Layer | Approach |
|---|---|
| `build-app.sh` | Manual: produces `Meet.app`; `codesign -dv .build/Meet.app` shows ad-hoc sig; `open` shows no Dock icon |
| `RunnerResolver` | Unit (XCTest): mock the `meet bin-path` output; verify node/main parsed; missing-binary path returns nil |
| Title prompt | Manual: Start → modal appears, default is last title, cancel aborts (no `meet` spawned) |
| Login Item | Manual toggle + relogin; verify status menu reflects `SMAppService.status` |
| End-to-end | Start from app → recording → Stop → `transcript.md` exists with chosen title; Start from CLI → app attaches (existing `SessionMonitor` path, regression-check it still works) |

No Node-side unit tests required (the only TS addition is `meet bin-path`, ~15 lines, trivial). No changes to the existing `node:test` suite.

---

## 5. Phase 2 — TCC permissions  *(OUTLINE — depends on a spike; outcome reshapes this section)*

**Why outline:** whether ad-hoc-signed `Meet.app` reliably prompts for Mic/Screen when its *child* (`AudioCapture`) touches the APIs is an **empirical** question. Phase 0's `.app` is the test vehicle. This phase is the single biggest source of uncertainty in the whole plan.

**Spike procedure (run immediately after Phase 0):**
1. `open Meet.app`, click Start.
2. Observe: do **both** Microphone and Screen Recording prompts appear, attributed to Meet / AudioCapture?
3. Grant; verify a real recording captures both channels (non-empty `mic-*.wav` and `sys-*.wav`).
4. Deny; verify graceful failure (no crash, clear message).

**Decision tree (fills this section in based on spike result):**
- **A. Prompts appear & work** → Phase 2 = minimal: add preflight checks (`AVCaptureDevice.authorizationStatus(for:.audio)`, `CGPreflightScreenCaptureAccess()`) on Start; if denied, deep-link to System Settings (`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`) and refuse to start.
- **B. Prompts suppressed / attributed wrong** → pre-request *from the app itself* before spawning children (`AVCaptureDevice.requestAccess(for:.audio)`, `CGRequestScreenCaptureAccess()`), so the app enters TCC first; then spawn. May still require the child binaries (`node`, `AudioCapture`) to be pre-granted via System Settings (one-time manual).
- **C. Persistent failure** → fallback considered: embed a minimal capture probe in the app to force the TCC entry, or (last resort, rejected in the locked decisions) embed full capture. This branch would expand Phase 2 substantially and is deliberately left un-detailed until the spike.

**Documented regardless of branch:** the exact binary that ends up holding each TCC grant (so `meet doctor` can later diagnose "permission granted to AudioCapture, not node" mismatches).

---

## 6. Phase 4 — Polish  *(OUTLINE — optional, appetite-dependent)*

- Live status in menu: read `session.json` (`processedChunks` count, `finalize` progress already written by `finalize.ts:60-93`) → show "Recording 12:34 · 48 chunks" and a "Finalizing… 60%" state.
- Fourth status icon for finalizing (currently only idle/recording/paused — `AppDelegate.swift:36-63`).
- App icon (`Meet.icns`).
- "Open last transcript" menu item (resolve newest dir in `~/Meetings`).
- Auto-update / version check — deferred to a distribution spec.

---

## 7. Downstream: п.2 scheduler & п.3 EventKit  *(OUTLINE — future specs, depend on Phases 0–3)*

Both become features **inside** `Meet.app` precisely because it is now a signed, always-running (Login Item) bundle in an Aqua session — the condition TCC needs. These are **separate specs**, sequenced after this one ships.

### п.2 Scheduled auto-start (outline)
- Internal `Timer`-driven scheduler in Swift reading `~/.meet/schedules.json` (cron-like `{title, days[], time, durationMin}`).
- New `meet schedule add/list/remove` (`cli.ts`) writing that file; the app hot-reloads it.
- Trigger → `meet start "<title>" --headless`; end → `SIGINT` on the lock PID. `isActiveRecording()` (`locks.ts:60-62`) already prevents double-starts.
- Reuses `RunnerResolver` + signal control from Phase 1 — no new plumbing.

### п.3 Calendar auto-start (outline)
- `EKEventStore` in `Meet.app` (needs `com.apple.security.personal-information.calendars`; TCC prompt for Calendars — possible only because the app is bundled/signed).
- Subscribe to selected calendars; N minutes before an event → start with the event title; at event end → stop.
- Builds directly on п.2's start/stop primitives.

---

## 8. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Ad-hoc signature breaks after binary rebuild / path change → TCC grants lost | Pin the bundle to a stable location (e.g. `~/Applications/Meet.app`); document that moving it re-prompts. Team-ID signing in a later spec fixes this permanently. |
| TCC prompts unreliable for child binaries (Phase 2 branch B/C) | Spike first (§5); preflight from app; one-time manual pre-grant documented in `meet setup`. |
| `SMAppService` "requiresApproval" state confuses users | Menu reflects real status; refusal path deep-links to System Settings. |
| `meet bin-path` adds a TS surface | Trivial helper; covered by the end-to-end manual test. |
| App runs while a CLI `meet start` is already active | Already handled: `SessionMonitor` attaches; `isActiveRecording()` prevents a second start. Regression-test the attach path. |

## 9. Open questions (non-blocking)
1. Persist last title in `UserDefaults` or `config.json`? Lean **UserDefaults** (Swift-local, no config schema churn).
2. Should the app refuse to Start if `meet setup` hasn't been run? Lean **yes** — `meet bin-path` failing is the signal; show the setup alert.
3. Stable install path for the bundle? Propose `~/Applications/Meet.app`; the build script leaves it in `.build` for dev.
