# Spec: Fix Plan from Project Review 2026-07-03

**Scope:** Issues found in review of current master (`5bad0da`).
**Context:** Most items from `ARCHITECTURE_REVIEW.md` (2026-06-13) and `CODE_REVIEW_68df7cd.md` (2026-06-18) were fixed (entries.jsonl, Recorder extraction, ~/.meet/sessions move, menu bar signals/node path/stop). This spec covers what remains plus new findings.

Verification baseline: build clean, `npm test` 220/220 pass.

---

## P1 — Correctness bugs (data loss / wrong behavior)

### F1. Finalizer never reads text from entries.jsonl

**Problem.**
`entries.jsonl` was introduced (commit `bcb4799`) so the finalizer can recover live-transcription text without parsing markdown. But `finalize.ts:203-204` consumes **only `rmsDb`** from the stored records; the `text` field is never used. `baseResults` (finalize.ts:218) is built from `fallbackEntries` (markdown parse — skipped whenever entries.jsonl exists, line 210) + `liveResults` (only chunks drained *by this finalizer process*).

Chunks transcribed during live recording are marked `done` in `processedChunks`, so the drain skips them — their text exists **only** in entries.jsonl and transcript.md, and neither reaches `baseResults`.

**Failure scenarios.**
1. `finalRetranscribe=false` or final model missing: `entriesFromSession(session, baseResults)` returns empty text for all live-transcribed chunks → they're dropped → `rewriteMarkdown` overwrites transcript.md with only drain-phase entries → **permanent loss** (session dir + WAVs deleted at finalize.ts:286).
2. Default path: `runFinalPass` per-chunk error fallback (`final-pass.ts:81-88`) looks up `liveEntries` = same incomplete `sessionEntries` → failed chunks silently lose their live text.
3. The safety guard at finalize.ts:274-278 ("final produced fewer entries than live, keeping live") compares against `fallbackEntries`, which is empty whenever entries.jsonl exists → guard is dead in exactly the cases it should protect.

**Requirements.**
- R1.1: Build `storedTextMap` from `readEntryRecords()` (`{source}-{index:3}` → `text`, non-empty only) and merge it lowest-priority into `baseResults`: `new Map([...storedTextMap, ...fallbackMap, ...liveResults])`.
- R1.2: The entry-count safety guard must compare against stored+live entries (after audio filter), not only markdown-parsed fallback.
- R1.3: `runFinalPass`'s `liveEntries` fallback must receive entries that include stored text (follows automatically from R1.1 since `sessionEntries` derives from `baseResults`).

**Acceptance criteria.**
- Given a session where chunks 1-5 were live-transcribed (present in entries.jsonl, absent from drain results) and `finalRetranscribe=false`, finalization produces a transcript containing chunks 1-5 text.
- Given the final pass throws on chunk 3, output contains chunk 3's live text from entries.jsonl.

**Tests.** New `finalize.test.ts` unit tests are hard (finalizeSession is monolithic); minimum: extract a pure `buildBaseResults(storedRecords, fallbackEntries, liveResults)` helper and unit-test priority/merging. Manual verification: run a short recording with `finalRetranscribe=false`, kill/finalize, diff transcript.

---

### F2. SIGWINCH extends the recording cap on every terminal resize

**Problem.**
`recorder.ts:520` registers `process.on("SIGWINCH", () => this.extendCap())`. SIGWINCH is delivered by the kernel to a foreground TTY process **every time the terminal window is resized**. Dragging a terminal corner fires dozens of events → cap extended +15m each → auto-stop effectively disabled, without the user knowing. The signal was chosen for the headless menu-bar path (`a5dccc1`) where no TTY exists, but registration is unconditional.

**Requirements.**
- R2.1: Register the SIGWINCH→extendCap handler **only when `opts.headless` is true** (menu bar is the only sender; interactive users have the `e` hotkey).
- R2.2: Remove the handler in `cleanup()` (see F4).

**Acceptance criteria.**
- Interactive session: resizing the terminal does not change `maxDurationMinutes` (no "Cap extended" log).
- Headless session: `kill -WINCH <pid>` extends cap by 15m exactly once per signal.

**Tests.** Unit-testable once F4 extracts handler registration; otherwise manual: start interactive recording, resize terminal, observe status line cap.

---

### F3. One corrupt line in entries.jsonl discards all records

**Problem.**
`entries-store.ts:12-26`: `JSON.parse` runs inside `.map()`; a single malformed line (torn write from a crash — the exact scenario this file exists to survive) throws, is caught by the outer try, and returns `[]`. All recovery data is silently discarded.

**Requirements.**
- R3.1: Parse per-line with try/catch; skip unparseable lines, keep the rest.
- R3.2: Distinguish "file missing" (return `[]` silently) from "lines skipped" (log a warning count to stderr).

**Acceptance criteria.**
- File with 10 valid lines + 1 truncated final line returns 10 records.

**Tests.** Extend `entries-store.test.ts`: torn last line, garbage middle line, empty lines.

---

### F4. Recorder signal handlers leak across sessions

**Problem.**
`recorder.ts:514-520` registers SIGUSR1/SIGUSR2/SIGWINCH via anonymous closures that `cleanup()` never removes (it only removes SIGINT/SIGTERM/stdin). The `n` (next-meeting) loop creates a new Recorder per meeting → handlers stack: `MaxListenersExceededWarning` after ~11 meetings, and stale handlers keep firing against dead Recorder instances (currently no-op'd by `shuttingDown` guards, but fragile).

**Requirements.**
- R4.1: Store SIGUSR1/SIGUSR2/SIGWINCH handlers as named fields (same pattern as `sigintHandler`) and remove them in `cleanup()`.
- R4.2: `shutdown()`/`stopAndFinalizeForeground()` paths exit the process, so cleanup there is optional but harmless; `nextMeeting()` path is mandatory.

**Acceptance criteria.**
- Running 15 consecutive meetings via `n` emits no MaxListeners warning; `process.listenerCount("SIGUSR1") === 1` during any session.

---

### F5. Menu bar elapsed time renders wrong (Swift padding)

**Problem.**
`RecordingController.swift:118-119`:
```swift
String(elapsed / 60).padding(toLength: 2, withPad: "0", startingAt: 0)
```
`padding(toLength:)` **right-pads or truncates**: 5 min → `"50"`, 105 min → `"10"`. The menu bar shows e.g. "50:30" for 5m03s.

**Requirements.**
- R5.1: Left-pad: `String(format: "%02d:%02d", elapsed / 60, elapsed % 60)`.

**Acceptance criteria.** 5m03s → "05:03"; 105m → "105:00" (or "1:45:00" — pick and document).

---

## P2 — Architecture debt (carried over from ARCHITECTURE_REVIEW.md, still open)

### F6. Stop path double-transcribes every pending chunk (review issue #6)

`finalizeSession` still drains the queue with the small model (`finalize.ts:185`) and then `runFinalPass` re-transcribes every WAV with the medium model. With F1 fixed, the drain adds nothing when a final pass will run: stored entries already cover per-chunk fallback.

**Requirements.**
- R6.1: When `finalRetranscribe` is on **and** the final model exists, skip the live drain (`pipeline.stop()` → `pipeline.close()`); go straight to the final pass.
- R6.2: Keep the drain when final pass won't run (no model / disabled), since then it's the only transcription.
- R6.3: The `s` hotkey path (`stopAndFinalizeForeground`) intentionally drains inline for a fast usable transcript — leave it, but note the finalizer will re-do those chunks (acceptable; or apply R6.1 there too and drop the `s`/`q` distinction — decide during implementation).

**Acceptance criteria.** Stopping a session with 10 pending chunks and final model present runs whisper-cli exactly 10 times (final pass only), not 20.

### F7. Dual chunk counters conflate produced vs consumed (review issue #7)

`micChunks`/`sysChunks` are written from both capture stderr events (`recorder.ts:142-150`, increments = chunks *produced*) and the transcribe callback (`recorder.ts:76-77`, `Math.max` of *consumed* index). Lag display conflates them.

**Requirements.**
- R7.1: Keep only the capture-event counters (producer side); read consumed count from `pipeline.getStats().totalDone` (already done for `transcribed:` display).
- R7.2: Delete the counter writes in the transcribe callback.

### F8. Critical write errors swallowed (review issue #8)

`appendEntry(...).catch(() => {})` (recorder.ts:98), `writeSession(...).catch(() => {})` (pipeline.ts:214, 223), `appendEntryRecord(...).catch(() => {})` (pipeline.ts:211). Disk-full/permission errors produce an empty transcript with zero signal.

**Requirements.**
- R8.1: Replace bare swallows with a rate-limited stderr warning (once per error class per session is enough).
- R8.2: entries.jsonl append failure should also set `session.lastError`.

---

## P3 — Cleanups (low risk, do opportunistically)

| # | Item | Location | Fix |
|---|------|----------|-----|
| C1 | CLAUDE.md says session state lives in `/tmp/meet-{id}` (3 places) — moved to `~/.meet/sessions/` in `aa3da47` | CLAUDE.md:35, 120, 302 | Update paths; also review AGENTS.md/PLAN.md per repo convention |
| C2 | "Run manually: meet recover (post-MVP)" suggests a command that doesn't exist | cli.ts:137 | Point at `meet finalize <sessionDir>` (which works) |
| C3 | `config.captureBin` is dead — `getCaptureBinPath()` never consults it | storage.ts:134, types.ts:52 | Honor it (`config.captureBin || repoDefault`) or delete the field |
| C4 | `checkFfmpeg` hardcodes Homebrew paths, ignores PATH | import.ts:467-470 | Use `which ffmpeg` fallback like whisper resolution |
| C5 | entries.jsonl `timestamp` is UTC transcription-time; transcript timestamps are local chunk-time | pipeline.ts:203 | Compute via `chunkToTimestamp()` for consistency (field becomes meaningful once F1 lands) |
| C6 | `loadConfig()` runs per chunk (undocumented hot-reload) + 40-line `??` chain | pipeline.ts:167, storage.ts:36-81 | Spread-merge `{...DEFAULT_CONFIG, ...fileConfig, ...overrides}`; document or lift the per-chunk reload |
| C7 | `drainQueue` busy-polls at 100ms while `processNext` self-chains | pipeline.ts:241-251 | Await a completion promise instead of polling |
| C8 | `appendEntry` unused `header` param | assembler.ts:49 | Drop param |
| C9 | Free-text stderr keyword grep still active alongside JSON protocol (review issue #9) | recorder.ts:152-160 | Once Swift-side free-text logging is gone, delete the grep branch |
| C10 | `promptTags` sets `session.tags` in memory only; session.json never gets tags; the tags re-read in finalize.ts:190-192 is vestigial | recorder.ts:222-236, finalize.ts:190-192 | Persist session.json after tag pick, or delete the re-read; meta.md already carries tags either way |
| C11 | import.ts `runWhisper` duplicates whisper arg list from transcriber.ts (drift risk; review issue #5 residue) | import.ts:271-285, transcriber.ts:149-163 | Extract shared `buildWhisperArgs(config, pass, format)` |

---

## Sequencing

1. **F1 + F3 + C5** — one PR: "make entries.jsonl the actual source of truth". Highest value; F3 and C5 are prerequisites for trusting the file F1 starts reading.
2. **F2 + F4** — one PR: signal handling hygiene in Recorder. Small, independent.
3. **F5** — one-line Swift fix, ship immediately.
4. **F6 + F7** — one PR: stop-path performance + honest status line. F6 depends on F1 (stored text replaces drain-as-fallback).
5. **F8 + P3 items** — opportunistic, alongside whichever PR touches the file.

Each PR: `npm run build && npm test` green; F1/F6 need one manual end-to-end recording (`meet start` → speak → stop → verify transcript + `meet status`).

## Non-goals

- No rewrite of `finalizeSession`'s fallback ladder beyond F1's helper extraction (works, tested in production).
- No change to Swift capture code except F5 (AudioCapture is stable).
- No new features; this is a reliability pass.
