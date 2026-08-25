# SPEC: Silent Start + Meeting Title Input on the Tag Windows

**Date:** 2026-08-25
**Status:** Approved — ready for implementation
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Three changes to how meetings get named, bundled because they form one flow:

1. **Remove the post-start naming popup entirely.** Clicking Start Recording goes mic-preflight → spawn → nothing else. No dialog follows.
2. **Add a meeting-title input to both tag-picker windows** ("Add Tag…" mid-call and the Stop window), prefilled with the live session's current title.
3. **Recorder-side fix:** apply a pending retitle during shutdown, so a rename submitted via the Stop window lands even when recording stops <5s later.

Context: instant start and the "Rename Meeting…" menu item already shipped (`852b41c`, `SPEC_NOTCH_MULTIDISPLAY_AND_DEFERRED_NAMING_2026-08-04.md`). The user-visible gating dialog they report is a **stale installed Meet.app binary**, not missing code — this spec removes the last remaining popup and moves renaming into the tag windows.

---

## 2. Current state (verified)

- `AppDelegate.startRecording()` (`AppDelegate.swift:158-185`) already starts under `"meeting"` immediately after the mic gate, then shows a non-blocking `promptText("Meeting title", "Recording already started — …")` and calls `submitRetitle(title)` on OK. Cancel is a no-op.
- "Rename Meeting…" exists in `.recording`/`.paused` menus → `renameMeeting()` → same `promptText` + `submitRetitle`.
- `submitRetitle()` (`AppDelegate.swift:358`) guards empty/"meeting" as no-op, saves `lastTitle`, calls `recordingController.retitle(title:)`.
- `recordingController.retitle()` spawns `meet retitle <sessionDir> <title>` synchronously; the CLI drops `retitle-request.json`; the live `Recorder.applyPendingRetitle()` (`recorder.ts:335`) does the folder move on its 5s status tick and rewrites `active-recording.lock` (`recorder.ts:383`) — so the lock always carries the fresh `title`.

### Gap found while speccing

`Recorder.promptTags()` (`recorder.ts:274-275`) calls `applyPendingTags()` at shutdown but **not** `applyPendingRetitle()`. Every stop path funnels through `promptTags()` (`shutdown()`, `stopAndFinalizeForeground()`, `nextMeeting()`, auto-stops). A marker dropped by the Stop window's rename would be applied only if ≥5s of recording remained — otherwise it sits orphaned while finalize writes to the old path. One-line fix required for item 3 above to work at all.

---

## 3. Target behavior

| Action | Result |
|---|---|
| Click **Start Recording** | Mic gate → spawn under `"meeting"` → done. No popup of any kind. |
| **Rename Meeting…** | Unchanged (existing menu item, existing prompt). |
| **Add Tag…** / **Stop** | Tag-picker alert gains a title field on top, prefilled with the current live title. OK applies a rename if the title changed, then tags as today. Cancel changes nothing. |
| Rename submitted ≤5s before Stop | Still applied — recorder picks up the marker during shutdown. |

---

## 4. Mechanics

### 4.1 `AppDelegate.swift` — drop the post-start popup

Delete lines 180–183 of `startRecording()` (the `defaultTitle` binding, the `promptText(...)` call, and the `submitRetitle(title)` call). Keep:

- the mic TCC preflight exactly where it is (`ensureMic()` before spawn — never behind the spawn);
- `self.recordingController.start(title: "meeting")`;
- the `@MainActor` pin and its comment (load-bearing: Timers must schedule on the main RunLoop).

Rewrite the leading comment (lines 154–157) to describe silent start: naming happens via "Rename Meeting…" or the tag windows.

`saveLastTitle()` loses no call site here — its remaining caller is inside `submitRetitle()`, which stays.

### 4.2 `AppDelegate.swift` — title input on the tag windows

- **Prefill source:** new `RecordingController.fetchCurrentTitle() -> String` returning `ActiveLock.read()?["title"] as? String ?? "meeting"`. Local JSON read, no spawn (mirrors `ActiveLock` usage in `currentSessionDir()`); safe to call right before opening the dialog. Freshness guaranteed by `applyPendingRetitle()` rewriting the lock after every move.
- **`promptTags(...)` signature:** return `(tags: [String], title: String)?` instead of `[String]?`. `nil` remains "cancelled".
- **UI:** one more `NSTextField` at the top of the vertical stack (above the checkboxes): prefilled with `fetchCurrentTitle()`, placeholder "Meeting title". Focus policy unchanged — `initialFirstResponder` and the queued `makeFirstResponder` stay on `newTagField` (the common action is picking tags, not renaming).
- **Call sites** (`stopRecording()`, `addTag()`):
  1. capture `originalTitle = fetchCurrentTitle()` before showing;
  2. on OK, if trimmed submitted title ≠ `originalTitle` → `submitRetitle(newTitle)`;
  3. then `setTags(tags)` exactly as today.
- Both spawns are synchronous (`waitUntilExit`), so ordering relative to the Stop-flow SIGINT is preserved regardless of internal order. Use retitle→tags to match top-to-bottom dialog order.
- `submitRetitle()`'s existing guard makes typing/clearing back to `"meeting"` a no-op — correct, since `"meeting"` is what's already live.

### 4.3 `src/recorder.ts` — apply pending retitle at shutdown

In `promptTags()`, next to the existing line:

```ts
this.applyPendingTags(); // catch anything queued in the last <5s before stop
this.applyPendingRetitle();
```

Why this insertion point is sufficient and safe:

- All stop paths funnel through `promptTags()`, so one line covers graceful shutdown, foreground stop, next-meeting, and auto-stops.
- Ordering inside `promptTags()`: the retitle runs **before** `writeMetaFile()` and `spawnBackgroundFinalizer()`, and `applyPendingRetitle()` updates `session.title`, `outputFile` (mutable), and `summaryScheduler.setOutputFile(...)` first — so `meta.md` lands in the renamed folder carrying the new title, and the finalizer targets the new path. Same invariant the 5s tick already maintains.
- `applyPendingRetitle()` early-returns when no marker exists — free no-op on every normal shutdown.
- Renaming the *meeting output dir* (`~/Meetings/...`) is independent of capture/pipeline teardown (chunks live in `sessionDir`, untouched).

### 4.4 Docs sync (per AGENTS.md convention)

- `docs/features.md:14` + `docs/ru/features.md:15`: menu-bar bullet currently says «ввод названия» / "enter a title" — rewrite to instant start, rename via menu/tag windows.
- `AGENTS.md:58` and `README.md` (~line 425): AppDelegate description "title modal" → non-blocking start + tag-window rename.
- `README.md` menubar prose if it mentions the naming flow.

### Files touched

| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | delete post-start popup; `promptTags` gains title field + tuple return; call sites apply retitle |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | `fetchCurrentTitle()` |
| `src/recorder.ts` | one line: `applyPendingRetitle()` in `promptTags()` |
| `docs/features.md`, `docs/ru/features.md`, `AGENTS.md`, `README.md` | doc sync |

---

## 5. Testing

Build & automated:

- `npm run lint && npm test` (existing recorder/assembler suites must stay green).
- `./native/MenuBar/scripts/build-app.sh`, restart Meet.app (stale-binary reset).

Manual:

1. Click Start Recording → recording starts, **no window appears**; folder `<ts>-meeting/` created.
2. Add Tag… mid-call, edit title, OK → folder renamed within ~5s; transcript continues at the new path; checkbox selection still saved.
3. Add Tag…, change title, **Cancel** → nothing renamed, nothing tagged.
4. Stop window: edit title + pick tags, OK → final `transcript.md` + `meta.md` in the renamed folder, `meta.md` carries new title and chosen tags (regression guard for §2 gap — must work even when OK lands <5s before SIGINT).
5. Stop window: leave title as-is → behaves exactly like today.
6. Clear the title field / type literal "meeting" → no-op rename, tags still applied.
7. Rename twice in one recording (menu, then tag window) → second rename moves from the first renamed folder.
8. Calendar auto-start path unaffected: starts headless under attendee title, no popups anywhere.

---

## 6. Non-goals / accepted

- No live title display in the notch panel or menu (folder name remains discoverable via Open Meetings Folder).
- Stale-header-during-recording after a rename stays accepted (final pass regenerates it — deferred-naming spec §Mechanics).
- No transactionality beyond what `applyPendingRetitle()` already has (crash between rename and `session.json` write remains a known, flagged gap).
