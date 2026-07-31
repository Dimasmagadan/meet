# SDD Spec: Stable Code Signing for TCC Permission Persistence

**Date:** 2026-07-31
**Status:** Draft — approved direction, pending implementation
**Owner:** Dmitrii Diakonov

---

## 1. Problem

Every time the user clicks the menu-bar icon and selects "Start Recording",
macOS re-prompts for Microphone and Screen Recording access — even though it
was already granted on a previous run. Expected behavior: prompt once, then
remember the grant across app restarts and rebuilds.

## 2. Root cause

`Meet.app` (menu-bar launcher) preflights Mic/Screen TCC access in its own
process (`PermissionController.swift`), then spawns `node` → which spawns the
`AudioCapture` Swift binary. `AudioCapture` is the process that actually calls
`SCStream`/`AVAudioEngine`, so it's the process macOS's TCC subsystem
attributes the permission grant to — not `Meet.app`.

There is already an uncommitted fix in `native/MenuBar/scripts/build-app.sh`
that switches `Meet.app`'s own code signature from ad-hoc (`codesign -s -`,
which mints a new cdhash — and thus a new TCC identity — on every rebuild) to
a stable self-signed identity ("Meet Self-Signed", already present in this
machine's keychain), falling back to ad-hoc when the cert isn't available.
That's the right idea, but it only fixes half the chain: `AudioCapture` — the
binary that actually triggers the prompts — has **no codesign step anywhere**
in the repo. It only gets the toolchain's automatic ad-hoc/linker signature,
which also gets a fresh cdhash every `swift build`. That's the actual reason
permission is forgotten and re-requested every time: the process macOS is
tracking for the grant has an unstable identity, regardless of what `Meet.app`
itself is signed with.

Confirmed via investigation:
- `Meet.app` bundle ID `com.dimasmagadan.meet.menubar` is fixed; its own
  signature (post uncommitted change) uses the stable "Meet Self-Signed"
  identity found via `security find-identity -p codesigning`.
- `AudioCapture` (`native/AudioCapture/.build/release/AudioCapture`) has
  `flags=0x20002(adhoc,linker-signed)` — no repo codesign step touches it.
- No entitlements plist exists for either target; `Info.plist` only carries
  usage-description strings. Neither target uses the hardened runtime.
- This exact ambiguity (which process TCC attributes the grant to) was
  flagged as an open, unverified question in
  `specs/SPEC_MENUBAR_UI_2026-07-30.md` §5 ("Phase 2 — TCC permissions...
  the single biggest source of uncertainty in the whole plan").

## 3. Fix

Give `AudioCapture` the same stable-identity treatment `Meet.app` just got,
so TCC grants survive rebuilds, and update the build/setup entry points so
this doesn't regress the next time someone runs a bare `swift build`.

### 3.1 Keep the existing uncommitted change

`native/MenuBar/scripts/build-app.sh` already signs `Meet.app` with "Meet
Self-Signed" (ad-hoc fallback if the cert is missing). No further edits
needed there.

### 3.2 New file `native/AudioCapture/scripts/build.sh`

Mirrors `native/MenuBar/scripts/build-app.sh`'s pattern exactly:

```sh
#!/bin/sh
set -e
cd "$(dirname "$0")/.."   # native/AudioCapture
swift build -c release
BIN=".build/release/AudioCapture"
if security find-identity -p codesigning | grep -q '"Meet Self-Signed"'; then
  SIGN_ID="Meet Self-Signed"
else
  SIGN_ID="-"
fi
codesign --force --sign "$SIGN_ID" "$BIN"
echo "Signed with: $SIGN_ID"
echo "Built: $PWD/$BIN"
```

Same identity as `Meet.app` (no reason to use a different cert), same ad-hoc
fallback for machines without it (CI / other contributors).

### 3.3 Repoint documented build command

Replace the raw `cd native/AudioCapture && swift build -c release` with
`./native/AudioCapture/scripts/build.sh` (run from repo root) everywhere it's
given as *the* build instruction, so the fix doesn't get silently undone the
next time someone rebuilds:

- `CLAUDE.md` (Quick Commands table)
- `AGENTS.md`
- `README.md`
- `CONTRIBUTING.md`
- `docs/quickstart.md` and `docs/ru/quickstart.md`
- `scripts/setup.sh` (the warning message telling the user how to build it
  when missing)
- `.claude/skills/dev-workflows/SKILL.md`
- `.opencode/skills/swift-audio/SKILL.md`

Not touching `PLAN.md`'s historical build note or the vendored `FluidAudio`
docs under `.build/checkouts` — not real doc surface.

## 4. Verification

1. `native/AudioCapture/scripts/build.sh` — should build and print `Signed
   with: Meet Self-Signed` (cert already present on this machine).
2. `codesign -dvvv native/AudioCapture/.build/release/AudioCapture` — confirm
   `Authority=Meet Self-Signed` (not `adhoc`).
3. Rebuild `Meet.app` via `native/MenuBar/scripts/build-app.sh`.
4. Manual end-to-end: `open Meet.app`, click Start, grant Mic + Screen
   Recording when prompted. Rebuild `AudioCapture` via the new script, quit
   and relaunch `Meet.app`, click Start again — no new prompt should appear.
   System Settings → Privacy & Security → Microphone/Screen Recording should
   keep the same single entry across the rebuild instead of a duplicate one
   appearing.

## 5. Non-goals

- Notarization / Developer ID signing — self-signed is sufficient for TCC
  identity stability on a local dev machine; not pursuing App Store or
  Gatekeeper-clean distribution here.
- Entitlements / hardened runtime — not required for this fix; neither
  target uses them today and adding them is out of scope.
