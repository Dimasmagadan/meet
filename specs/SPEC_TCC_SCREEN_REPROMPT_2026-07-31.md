# SDD Spec: Kill the Recurring Screen-Recording Prompt (Menu-Bar Start)

**Date:** 2026-07-31
**Status:** Phase 1 verified insufficient (re-prompt persisted after tactical fix) → Phase 2 implemented (Core Audio process tap rewrite of `SystemAudioCapture.swift`, `main.swift` availability guard, `PermissionController`/`AppDelegate`/Info.plist updated). Needs a real-meeting smoke test per §7.4 before merge.
**Owner:** Dmitrii Diakonov
**Predecessor:** `specs/SPEC_TCC_SIGNING_2026-07-31.md` (implemented in ef16b44 — necessary but not sufficient)

---

## 1. Problem

Starting a recording from the Meet.app menu-bar item shows a system permission
prompt **every time**, even though System Settings shows the permission as
granted. This persists *after* ef16b44 gave both `Meet.app` and `AudioCapture`
a stable "Meet Self-Signed" code-signing identity.

## 2. What today's investigation established

Verified on this machine (macOS 26.5.1, build 25F80):

1. **The signing fix works.** Both binaries carry `Authority=Meet Self-Signed`
   with designated requirement
   `identifier "com.dimasmagadan.meet.menubar" and certificate root = H"e39c…"` —
   stable across rebuilds.
2. **Microphone is NOT the recurring prompt.** The user TCC db
   (`~/Library/Application Support/com.apple.TCC/TCC.db`) has exactly one row
   for us: `kTCCServiceMicrophone` / `com.dimasmagadan.meet.menubar` /
   `auth_value=2` (allowed), recorded 2026-07-30 21:44, and its stored `csreq`
   blob decodes to **exactly the current designated requirement**. The mic
   grant survives rebuilds. The recurring prompt is **Screen Recording**.
3. **Screen Recording grants live in the system TCC db**
   (`/Library/Application Support/com.apple.TCC/TCC.db`, root-only) — not yet
   inspected. This is the single missing piece of evidence (Phase 0).
4. **ScreenCaptureKit's approval-nag state never persisted for Meet.**
   `~/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist`
   has entries for `com.googlecode.iterm2`, `com.brave.Browser`, etc. — but
   none for `com.dimasmagadan.meet.menubar`. The iTerm2 entry also explains
   why `meet start` from the terminal never prompts: TCC attributes the
   capture to the *responsible process* (iTerm2), which already holds the
   grant.
5. **The menu-bar code prompts by design whenever preflight fails.**
   `PermissionController.ensureScreen()` runs
   `CGPreflightScreenCaptureAccess()` and, on `false`, fires
   `CGRequestScreenCaptureAccess()` — on **every Start click**. Any state in
   which preflight stays `false` (stale csreq, grant under a different client,
   grant under a different *service*) produces exactly the reported symptom.
6. **We request more than we use.** `SystemAudioCapture.swift` captures audio
   only (`capturesAudio = true`, 2×2 px video mandated by SCK), but
   `SCShareableContent` + display filter requires **full Screen Recording**.
   Since macOS 14.4 there is a separate, narrower **"System Audio Recording
   Only"** permission (`kTCCServiceAudioCapture`) that our SCK path cannot
   use (same mismatch OBS hit:
   https://github.com/obsproject/obs-studio/issues/10401).
7. `Info.plist` carries `NSScreenCaptureDescription` — not a real TCC key
   (screen-recording prompts use system-provided text); it's a no-op.

## 3. Hypotheses (ranked) — Phase 0 discriminates

| # | Hypothesis | System-db signature |
|---|-----------|---------------------|
| H1 | Stale `kTCCServiceScreenCapture` row: csreq captured from a pre-ef16b44 ad-hoc build; Settings shows the toggle ON but validation fails; re-toggling doesn't refresh the csreq (known TCC staleness) | Row for `com.dimasmagadan.meet.menubar`, `auth_value=2`, csreq ≠ current DR |
| H2 | Grant landed under **System Audio Recording Only** (`kTCCServiceAudioCapture`) — Settings pane shows "granted", but `ensureScreen()` preflights/requests **full** Screen Recording → prompt every click | `kTCCServiceAudioCapture` row allowed; no/denied `kTCCServiceScreenCapture` row |
| H3 | Grant attributed to a different client (`node`, path-based `AudioCapture`, or iTerm2) than the requester (Meet.app) | Allowed row exists, but client ≠ `com.dimasmagadan.meet.menubar` |
| H4 | macOS 26 SCK periodic re-approval (replayd) refuses to persist approval state for the self-signed app | Valid ScreenCapture row + current csreq, yet prompt recurs; Meet still absent from `ScreenCaptureApprovals.plist` after allowing |

## 4. Phase 0 — Decisive diagnostics (user-run, ~1 min)

```sh
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "SELECT service, client, client_type, auth_value, datetime(last_modified,'unixepoch')
   FROM access WHERE service IN ('kTCCServiceScreenCapture','kTCCServiceAudioCapture')
   ORDER BY service, client;"
```

Plus one observation: the **literal text** of the recurring dialog
(first-grant style "…would like to record this computer's screen and audio"
vs. the periodic "…is requesting to bypass the system private window picker" /
"Continue to Allow" nag).

Interpretation: match against the table in §3. Multiple hypotheses can hold
simultaneously (e.g. H1 + H4).

## 5. Phase 1 — Tactical fixes (do regardless of Phase 0 outcome)

### 5.1 Stop the prompt-on-every-click loop

`PermissionController.ensureScreen()` currently *guarantees* a prompt storm
whenever preflight fails. Remove the `CGRequestScreenCaptureAccess()` call;
keep `CGPreflightScreenCaptureAccess()` as an informational status only.
First-run UX is preserved: `AudioCapture`'s `SCShareableContent` call triggers
the proper TCC prompt itself, attributed to Meet.app as the responsible
process. On capture failure, surface the existing `onStartFailed` alert with
the `openPrivacySettings(.screenCapture)` deep link instead of pre-prompting.

### 5.2 Clean-slate re-grant (clears H1/H3 residue)

```sh
sudo tccutil reset ScreenCapture com.dimasmagadan.meet.menubar
tccutil reset ScreenCapture   # only if a stale node/AudioCapture/path-based entry shows in Phase 0
```

Then: remove any leftover Meet/node/AudioCapture rows in System Settings →
Privacy & Security → Screen & System Audio Recording (− button), relaunch
Meet.app, Start, grant **once**. Do NOT reset Microphone — its grant is
already valid.

### 5.3 Info.plist hygiene

Drop the no-op `NSScreenCaptureDescription`. (Phase 2 adds
`NSAudioCaptureUsageDescription`.)

## 6. Phase 2 — Root-cause fix: Core Audio process tap (recommended)

Even with H1–H3 fully repaired, SCK screen capture on macOS 15/26 is subject
to **periodic re-approval** (replayd nag, ~30–90 day policy per app, §2.4) —
and H4 may make that per-launch for a self-signed app. The only way to zero
prompts *and* honestly scope our permission is to stop using ScreenCaptureKit
for what is audio-only capture:

Rewrite `SystemAudioCapture.swift` on **Core Audio process taps**
(macOS 14.2+): `CATapDescription` (global tap, mono mixdown, excluding own
process — mirrors `excludesCurrentProcessAudio`) →
`AudioHardwareCreateProcessTap` → private aggregate device with the tap →
`AudioDeviceCreateIOProcID` callback → downmix/resample to 16 kHz mono
(reuse MicCapture's manual linear-interpolation resample pattern — the
AVAudioConverter ban in `native/AudioCapture/CLAUDE.md` applies) →
existing `WAVWriter` unchanged.

Consequences:
- Permission becomes **System Audio Recording Only** — granted once, no
  screen-recording TCC involvement, no replayd nag (that machinery is
  SCK/screen-content specific).
- `Info.plist` (Meet.app, the responsible process): add
  `NSAudioCaptureUsageDescription`.
- `ensureScreen()` and `PrivacyPane.screenCapture` deep-link retarget or
  drop; `meet setup`/`doctor` permission checks update accordingly.
- `Package.swift` stays `.macOS(.v14)`; guard the tap path with
  `@available(macOS 14.2, *)` and a clear startup error below it (dev
  machine is 26.5; SCK fallback for 14.0–14.1 is a non-goal).
- Node side untouched: same `sys-*.wav` chunk contract, same restart
  semantics (re-arm via device/tap property listeners in place of
  `didStopWithError`).

Ship Phase 1 first; Phase 2 is a standalone PR gated on a 2-meeting smoke
test of tap audio quality vs. SCK (Bluetooth + speaker playback).

## 7. Verification

1. After Phase 1: launch Meet.app → Start → grant once → Stop → quit →
   relaunch → Start → **no prompt**.
2. Rebuild both binaries via their build scripts → relaunch → Start →
   **no prompt** (proves identity stability end-to-end).
3. Phase 0 query re-run: exactly one allowed row for
   `com.dimasmagadan.meet.menubar`, csreq matching the current DR.
4. After Phase 2: `kTCCServiceScreenCapture` row for Meet can be deleted
   entirely; recording works with only "System Audio Recording Only" granted;
   `sys-*.wav` chunks transcribe normally in a real meeting.
5. Regression: `meet start` from iTerm still works (responsible process
   iTerm2, unchanged).

## 8. Non-goals

- Notarization / Developer ID — unchanged from predecessor spec.
- SCK fallback for macOS 14.0–14.1 system audio.
- Suppressing the periodic nag while *staying* on SCK (the Persistent Content
  Capture entitlement is Apple-approval-gated, for VNC-class apps).
- Mic path changes — proven working.
