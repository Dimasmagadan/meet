# SPEC: Notch Live-Transcript Panel

**Date:** 2026-08-03
**Status:** Draft — reviewed, pre-implementation
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Add a hover-revealed panel anchored at the physical display notch (MacBook 14"/16", M1 Pro+) showing the **live transcript** of the currently active recording. Builds on the existing `native/MenuBar/` app (`Meet.app`) — additive, does not touch the existing `NSStatusItem` menu (Start/Stop/Pause/Tags stay exactly where they are).

### v1 scope
- Read-only. One piece of content: the tail of the live transcript (last N lines that fit).
- Hidden by default. Hover near the notch reveals it; moving away hides it again.
- Only active while a recording is in progress (idle → nothing to show, panel never reveals).
- Only on the **primary display**, and only if that display actually has a notch. No notch (external monitor as main, older MacBook, clamshell) → feature is simply inactive, no fallback UI.

### Non-goals (v1)
- No recording controls in the panel (Start/Stop/Pause/Tags remain in the status-item menu).
- No other widgets (status, timer, tags, talk-time) — deliberately one thing; extension is a future spec.
- **No scrolling / no scrollback.** Tail only. The panel is a hover-peek that disappears when the cursor leaves; a scroll-position state machine for 4 visible lines is not worth building. Add when it's actually missed.
- No secondary-display or non-notch fallback.

---

## 2. UX behavior

- **Trigger zone**: the notch's own rect (from `NSScreen.auxiliaryTopLeftArea` / `auxiliaryTopRightArea`, macOS 12+) plus a small margin below/sides for comfortable aim.
- **Hover in** → panel animates open downward from the notch.
- **Hover out** → panel animates closed after a short delay (~300–500ms, tune after real use) so passing the cursor by doesn't flicker it.
- **Content**: the last N transcript lines that fit, re-read from disk while revealed. New lines simply replace the tail — no scroll, no stick-to-bottom logic.
- **Empty state**: `transcript.md` opens with a `# Title — date` header + blank line (`makeHeader()` in `src/assembler.ts`), so header lines must be filtered out, not displayed. Keep only lines starting with `**[`; none → placeholder "Ждём данные…".
- **Size**: fixed, no dynamic resize — **400pt wide, height ≈ 4 lines of text**. At 400pt centered on the notch the panel covers ~180pt of menu bar on each side, hiding the frontmost app's menu titles while revealed. **Accepted** — it's transient and only while hovering.
- **Visibility gate**: panel only arms (starts listening for hover) while `RecordingController.state` is `.recording` or `.paused`. Idle → hover zone does nothing.

---

## 3. Architecture (`native/MenuBar/`)

1. **Notch geometry** — inline in `NotchPanelController` (~10 lines, not its own file): notch present iff `screen.safeAreaInsets.top > 0`; notch rect x-range is `auxiliaryTopLeftArea.maxX … auxiliaryTopRightArea.minX` on `NSScreen.main`. No notch → controller stays dormant, no window created.
   - Geometry is recomputed **on each arm** (recording start), which covers display reconfiguration for the real case. No `didChangeScreenParameters` observer.
2. **One window, not two** — a single borderless window whose collapsed frame *is* the notch rect (+ margin). On `mouseEntered` its frame animates to full height; on exit it animates back. The notch is a physical black cutout, so a window sitting on it is invisible by definition — a separate invisible detector window buys nothing and adds cross-window coordination.
   - Must be an **`NSPanel`** with `.nonactivatingPanel`, `isFloatingPanel = true`, `hidesOnDeactivate = false`, `isReleasedWhenClosed = false`. `Meet.app` is `LSUIElement`; a plain `NSWindow` would steal focus from whatever call the user is in.
   - Tracking area must use **`.activeAlways`**. The panel is never key, so the default `.activeInKeyWindow` yields a panel that silently never fires. This is the single most likely way v1 ships broken.
   - `collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]` — without it the panel exists on one Space only. `.fullScreenAuxiliary` may also cover the full-screen-app case in §6; verify before assuming it doesn't.
   - Content is a plain `NSTextField` (no `NSScrollView`, no `NSTextView` — see §1 non-goals), `.statusBar` level, no shadow.
3. **Live transcript source** — reuses the file the TS pipeline already writes to incrementally (`appendEntry()` in `src/assembler.ts`, called from `src/recorder.ts:121`), no new IPC.
   - **Path**: `transcript.md` lives at `session.outputFile` → `~/Meetings/<slug>/transcript.md`, **not** in `sessionDir`. `writeActiveRecordingLock` (`src/locks.ts:25-33`) currently carries only `pid / sessionDir / title / startedAt`, so the panel has no way to find it. Fix is one line in `locks.ts` (see §4); Swift then reads it exactly like `RecordingController.currentSessionDir()` (`RecordingController.swift:204`).
   - Rejected alternative: `<sessionDir>/entries.jsonl` (`pipeline.ts:213`) is already inside `sessionDir`, but Swift would have to decode JSON per line and re-derive the `Me:` / `Speaker N:` labels. `transcript.md` is already display-ready.
   - **Poll only while revealed** — start the ~1s timer in `mouseEntered`, invalidate it in `mouseExited`. No background timer running through a 2h call. This also removes any need for a `DispatchSource.makeFileSystemObjectSource` upgrade path; a hover lasts seconds and 1s polling is fine at that scale.
   - Tail extraction (read file → drop header/blank lines → last N `**[`-prefixed lines → placeholder if empty) is a **pure function**, so the one piece of non-trivial logic has a runnable check (§5).
4. **Session wiring** — `AppDelegate.swift:21` already owns the single `recordingController.onStateChange` closure, and `RecordingController.startTimer` (line 240) re-fires it at 1Hz. Arm/disarm is **one line added inside that existing closure** and must be idempotent (arming an already-armed panel is a no-op).

---

## 4. Files touched

| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/NotchPanelController.swift` | **new** — notch geometry, the single hover panel, reveal/hide animation, while-revealed transcript polling, pure tail extraction |
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | instantiate `NotchPanelController`; one idempotent arm/disarm line inside the existing `onStateChange` closure |
| `src/locks.ts` | **one line** — add `outputFile: session.outputFile` to `writeActiveRecordingLock`, plus the field on `ActiveRecordingLock` |
| `native/MenuBar/Package.swift` | no change — AppKit only, no new dependency |

No pipeline changes beyond the lock field — transcript file already exists and is already written incrementally.

---

## 5. Testing

Automated: one check on the pure tail-extraction function — header line + blank line + 6 entry lines → returns the last N entry lines, header excluded; empty/entry-less input → placeholder.

Manual (no headless way to assert `NSPanel` hover/visibility):
- Idle, hover over notch → nothing appears.
- Start recording, hover over notch → panel reveals, shows transcript tail (or "Ждём данные…" if nothing transcribed yet), **not** the `# Title` header.
- New chunk transcribed while hovering → tail updates within ~1s.
- Move cursor away → panel closes after the hide delay; confirm the poll timer stopped.
- Hover, then click through to the app behind → focus is not stolen (`.nonactivatingPanel`).
- Switch Spaces mid-recording → panel still reveals on the new Space.
- External display set as primary (no notch) → feature stays fully inactive, no window created, no crash.
- Stop recording → panel stops arming; if left open, hides (state change back to idle).

---

## 6. Open questions / risks

- Full-screen apps that take over the notch area — `.fullScreenAuxiliary` may handle this; test before declaring it unhandled.
- Hide delay (300–500ms) is a guess, tune after real usage.
- Tail-only, 4 lines: long transcripts are never scrollable in v1 by design. Revisit only if the peek genuinely isn't enough.
