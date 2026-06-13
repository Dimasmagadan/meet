# Architecture Review: Meet

**Date:** 2026-06-13  
**Focus:** System-level design patterns and state management

---

## Executive Summary

The project has a solid foundation: clean Swift/Node boundary via atomic WAV handoff, sequential transcription queue, and first-class crash recovery. However, state management is fragmented (session.json has multiple writers), and critical recovery paths depend on lossy round-tripping of human-readable formats. The recording orchestration lives in a 420-line god function, and the import path duplicates the live transcription stack.

Priority fixes: establish session state ownership, switch to structured persistence for transcription entries, eliminate redundant double-transcription, and extract testable orchestration.

---

## Critical Issues

### 1. Session State Has Multiple Writers, No Single Owner

**Problem:** `session.json` is mutated by three independent processes—the recording loop, the Pipeline, and the finalizer—each holding its own in-memory copy and doing last-write-wins via `writeAtomic`. The codebase patches over this with re-reads:

- `finalizeSession` (line 149) re-reads the session mid-flight to pick up tags that might have been added by `promptTags`
- `promptTags` (line 303) re-reads "latest" before merging tags back

These patches are symptoms of missing ownership. If the keyboard handler (`promptTags`) and the pipeline's `writeSession` interleave, one silently overwrites the other.

**Location:**
- Recording writes: `cli.ts:216`, `cli.ts:292`, `cli.ts:328`
- Pipeline writes: `pipeline.ts:194`, `pipeline.ts:203`
- Finalizer writes: `finalize.ts:38`, `finalize.ts:99`, `finalize.ts:222`

**Suggested fix:**
Establish explicit ownership per lifecycle phase:
- **Recorder** owns session until `status = "queued"`
- **Finalizer** owns session from `status = "queued"` onward

Funnel all writes through a single `mergeAndWrite()` function that does: read current → merge incoming changes → atomic write. This prevents silent clobbers.

---

### 2. Transcript.md Is Used as Both Presentation and Database

**Problem:** During finalization, if live results are incomplete, the code falls back to *parsing the human-readable markdown back into entries* (`assembler.ts:82` via `parseTranscriptEntries`). It reverse-engineers chunk indices from wall-clock timestamps using a midnight-crossing heuristic:

```typescript
const chunkIndex = Math.round(diff / chunkDurationSeconds) + 1
```

This round-trip is lossy and fragile:
- Any change to display format (`Me`/`Others` labels, bolding) silently breaks recovery
- Processing lag causes misattribution: if chunk 5 takes 20s to transcribe, the timestamp may fall in chunk 7's window
- The regex at `assembler.ts:84` only matches the specific format; a label typo means no entries are parsed

**Location:**
- Parsing: `assembler.ts:82-94`
- Reverse-mapping: `assembler.ts:67-80`
- Fallback calls: `finalize.ts:163-165`, `finalize.ts:173-176`, `finalize.ts:193-197`, `finalize.ts:201-205`

**Suggested fix:**
Persist live results to a machine format alongside the session:
- Add `entries.jsonl` to the session dir: one JSON object per line, one append per chunk
- Format: `{"source":"mic","index":5,"text":"...","timestamp":"HH:MM:SS","rmsDb":-45.3}`
- Same atomicity story: write to `.tmp`, rename

Then `transcript.md` becomes a pure render target. The entire `parseTranscriptEntries`/`timestampToChunkIndex` reverse-mapping layer is deleted, and recovery always has exact ground truth.

---

### 3. Audio and State Live in /tmp, Contradicting Durability

**Problem:** Session dirs (WAV chunks + session.json) are in `/tmp` (`cli.ts:134`). macOS purges /tmp on reboot and periodically deletes untouched files after ~3 days. The most likely crash scenario for a recording app—machine dies mid-meeting, user reboots—is exactly the one where all recoverable data is deleted.

The final-pass design makes this worse: the *only* source for high-quality transcription is the WAVs, which are the most ephemeral artifacts.

**Location:**
- Session dir creation: `cli.ts:134`
- Stale session detection: `storage.ts:116-140`

**Suggested fix:**
Move session dirs to `~/.meet/sessions/{id}` or nest them inside the meeting output dir itself. Clean them up explicitly after `status = "done"`. Reserve /tmp for short-lived artifacts like `doctor` temp dirs only.

---

### 4. `startSession` Is a 420-Line God Function

**Problem:** `cli.ts:109-526` owns: capture process spawning + kill escalation, stderr protocol parsing, keyboard/raw-mode handling, status-line rendering, auto-stop policy, tag prompting, shutdown orchestration, background-finalizer spawning—all as closures over ~10 pieces of mutable state:

```typescript
let shuttingDown = false, autoStopReason, opencodeRunning, statusInterval, 
    micChunks, sysChunks, ...
```

The consequence: the trickiest logic (shutdown state machine, auto-stop trigger conditions) is untestable. Every module has unit tests except the orchestration layer.

**Location:** `cli.ts:109-526`

**Suggested fix:**
Extract a `Recorder` class (or `SessionRunner`) into `src/session-runner.ts`:
- Owns lifecycle state and policy (`checkAutoStop`, shutdown sequencing)
- Exposes events: `on("transcribed")`, `on("health-warning")`, `on("stopped")`
- `cli.ts` becomes thin command wiring that calls `recorder.start()` and listens to events

This makes auto-stop logic and shutdown sequencing unit-testable in isolation.

---

### 5. Two Parallel Transcription Stacks (Import vs. Live)

**Problem:** `import.ts` reimplements whisper invocation independently:

- `import.ts:262` `runWhisper()` with a duplicated argument list that must stay in sync with `transcriber.ts:137`
- `import.ts:467` `findWhisper()` hardcoded paths, ignoring `config.whisperBin` (while `transcriber.ts:155` uses it)
- A hand-faked `Session` object just to satisfy tag-picker (`import.ts:169`)
- The two paths have already drifted: import uses `-oj` + segment timestamps, live uses `-otxt --no-timestamps`

Same disease in binary discovery: whisper-cli paths hardcoded in three places (`cli.ts:537`, `cli.ts:571`, `import.ts:468`), and `checkSetup` ignores `config.whisperBin`.

**Location:**
- `import.ts:262-310` (runWhisper)
- `import.ts:467-470` (findWhisper)
- `transcriber.ts:137-152` (args)
- `transcriber.ts:155` (config.whisperBin)

**Suggested fix:**
Extract `runWhisperCli(wavPath, config, options?)` in `transcriber.ts` that both paths call. Add `resolveBinary(config, name)` helper to find binaries once.

---

### 6. Finalization Double-Transcribes by Design

**Problem:** When you stop a recording, `finalizeSession`:

1. **Drains the queue with the live (small) model** (`finalize.ts:144` → `pipeline.stop()`)
2. **Then re-transcribes every chunk with the medium model** (`finalize.ts:187` → `runFinalPass` walks all WAVs)

The live drain results are only used as a per-chunk fallback if the final pass fails. So every untranscribed chunk gets whisper'd twice, sequentially. For a long meeting with lag, this meaningfully delays the final transcript.

**Location:**
- Live drain: `finalize.ts:144-147`
- Final pass: `finalize.ts:187-190`
- Redundant condition: `finalize.ts:213-216`

**Suggested fix:**
When the final model exists and `finalRetranscribe` is on, skip the live drain entirely. Use `liveEntries` (already available from the live-phase results) only as a fallback for chunks the final pass errors on—which `runFinalPass` already handles.

Also: `filterEntriesByAudio` (line 65) re-reads and re-analyzes full WAV files, and the fallback ladder calls it up to three times over overlapping sets. Extract one `buildFinalEntries()` helper.

---

## Secondary Issues

### 7. Two Sources of Truth for Chunk Counters

**Problem:** In `startSession`, `micChunks`/`sysChunks` are updated from *both*:
- Capture stderr events: `++` at `cli.ts:228-236` (chunks *produced*)
- Transcribe callback: `Math.max(count, index)` at `cli.ts:175-176` (highest *consumed*)

These measure different quantities with different semantics. The status line's lag computation conflates them.

**Location:** `cli.ts:171-237`, `cli.ts:388-422`

**Fix:** Use one source—either the capture events (real producer count) or `pipeline.getStats()` (real consumer count), not both.

---

### 8. Error Swallowing as House Style

**Problem:** Critical writes fail silently:
- `appendEntry(...).catch(() => {})` (`cli.ts:190`) → live transcript write failure produces empty transcript with zero signal
- `writeSession(...).catch(() => {})` (`pipeline.ts:194`, `pipeline.ts:203`) → session state loss

Swallowing errors is only acceptable where there's a genuine fallback.

**Location:** `cli.ts:190`, `pipeline.ts:194`, `pipeline.ts:203`

**Fix:** Swallow only non-critical paths. Log disk-full / path-invalid errors to stderr at minimum.

---

### 9. Dual Stderr Protocol

**Problem:** Swift emits structured JSON but also free-text (`fputs` + `logJSON`, `main.swift:55-108`). Node keyword-greps text lines (`line.includes("failed")...` at `cli.ts:238-246`).

**Location:** `main.swift:55-108`, `cli.ts:219-248`

**Fix:** Make JSON the only contract. Drop free-text logging and the keyword-matching grep.

---

### 10. `loadConfig` Boilerplate

**Problem:** 40 lines of per-field `??` chains (`storage.ts:21-53`) where object spread does the same:
```typescript
return { ...DEFAULT_CONFIG, ...fileConfig, ...overrides }
```

Also: `loadConfig()` runs per-chunk in `pipeline.ts:157` — if this is intentional hot-reload, document it; otherwise lift it out.

**Location:** `storage.ts:14-54`

**Fix:** Use object spread. Pass `config` once to `Pipeline` constructor.

---

### 11. Tilde Expansion Reimplemented Inline

**Problem:** `expandPath` exists (`storage.ts:10-12`) but is reimplemented inline:
- `cli.ts:177` and `transcriber.ts:120-122` with different behavior
- `replace("~", HOME)` replaces anywhere in the path (wrong if `~` appears later)

**Location:** `cli.ts:177`, `transcriber.ts:120-122`

**Fix:** Always use `expandPath()`.

---

### 12. Dead/Vestigial Code

- `appendEntry`'s unused `header` parameter (`assembler.ts:49`)
- `CaptureRunner.shouldStop` shadowed by the relay singleton (`main.swift:38`)
- `Pipeline.drainQueue` busy-polling at 100ms while `processNext` already self-chains (two drivers for one queue)

---

## Strengths Worth Preserving

- **Atomic `.tmp` → rename discipline** applied consistently on both language boundaries
- **Finalizer lock with stale-PID cleanup** (`locks.ts`) is correct and simple
- **Sequential queue** avoids resource exhaustion
- **Per-module test coverage** of pure logic (filters, assembler, audio-metrics) is solid

---

## Recommended Fix Priority

1. **Issue #2** (entries.jsonl) — high-value, self-contained, unblocks reliable recovery
2. **Issue #6** (skip redundant drain) — removes wasteful double-transcription
3. **Issue #4** (extract Recorder) — bigger refactor, unlocks testing of orchestration
4. **Issue #1** (session ownership) — clarifies state flow, prevents silent clobbers
5. **Issue #3** (move /tmp → ~/.meet) — long-term durability
6. **Issue #5** (unify transcription stacks) — reduces maintenance surface

---

## Testing Notes

Current coverage:
- ✅ `filters.test.ts`, `assembler.test.ts`, `audio-metrics.test.ts`, etc. — pure logic
- ✅ `phrasebook.test.ts`, `transcriber.test.ts` — I/O mocks
- ✅ `import.test.ts`, `capture-health.test.ts` — integration stubs
- ❌ `startSession` orchestration (420 lines, zero tests)
- ❌ `Pipeline` with health monitor and auto-stop
- ❌ Finalization fallback ladder

Extracting Recorder (issue #4) makes the missing tests tractable.
