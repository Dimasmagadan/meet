# Architecture Fix Plan: Meet

## Context

The architecture review identified 6 critical and 6 secondary issues. This plan addresses them in dependency order. The two foundational problems are: (A) transcription results stored only in human-readable markdown, which requires a lossy reverse-parse for recovery; and (B) the 420-line `startSession` god function that makes orchestration logic untestable. Other issues are either quick wins that don't depend on anything, or follow naturally from the big refactors.

Execution order: fix #2 first (self-contained, foundational), then #6 (quick win), then #5 (unify whisper), then #4 (Recorder refactor), then #1 (ownership), then #3 (/tmp).

---

## Phase 1 — entries.jsonl (Issue #2)

**Goal:** Eliminate the markdown-as-database pattern. The fallback in `finalizeSession` currently regex-parses `transcript.md` back into entries and guesses chunk indices from wall-clock timestamps — this is lossy and fragile.

### New file: `src/entries-store.ts`

```typescript
// Append one entry to <sessionDir>/entries.jsonl atomically
export async function appendEntryRecord(sessionDir: string, entry: EntryRecord): Promise<void>

// Read all records from <sessionDir>/entries.jsonl
export async function readEntryRecords(sessionDir: string): Promise<EntryRecord[]>

// EntryRecord shape (matches TranscriptEntry + rmsDb for audio gate)
export interface EntryRecord {
  source: "mic" | "sys";
  index: number;            // chunk index
  timestamp: string;        // HH:MM:SS
  text: string;
  rmsDb: number;
}
```

Append strategy: write `JSON.stringify(record) + "\n"` using `appendFile` (not atomic per-line — jsonl by definition is append-safe). File is created on first transcription.

### Changes to `pipeline.ts`

In `processNext()`, after successful transcription, call `appendEntryRecord(session.sessionDir, {...})` with the result and its `metrics.rmsDb`.

### Changes to `finalize.ts`

Replace the `fallbackEntries` / `parseTranscriptEntries` block (lines 161-165) with:
```typescript
const storedEntries = await readEntryRecords(sessionDir);
```
The stored entries already have exact chunk indices and rmsDb — no reverse-mapping needed. Remove `filterEntriesByAudio` calls that re-read WAVs to get rmsDb (it's already in the record). Collapse the four near-identical fallback ladder blocks into one `buildFinalEntries()` helper.

### Changes to `assembler.ts`

- Remove `parseTranscriptEntries` and `timestampToChunkIndex` — no longer needed
- Remove `transcriptEntriesToMap` — no longer needed (or keep if used in tests)
- `rewriteMarkdown` stays unchanged (render-only)

### Files touched
- `src/entries-store.ts` (new)
- `src/pipeline.ts` (append record per chunk)
- `src/finalize.ts` (use stored entries, collapse fallback ladder)
- `src/assembler.ts` (delete reverse-parsing logic)
- `src/types.ts` (add `EntryRecord` interface)

---

## Phase 2 — Skip Redundant Drain (Issue #6)

**Goal:** When `finalRetranscribe` is on and the final model exists, skip the live-model drain on shutdown. Currently every untranscribed chunk is whisper'd twice.

### Change in `finalize.ts`

Current flow:
1. `pipeline.stop()` → drains queue with small model
2. `runFinalPass()` → re-transcribes everything with medium model

New flow:
```
if finalRetranscribe && finalModelExists:
    skip pipeline.stop() drain (don't pass live progress callback)
    use entries.jsonl as liveEntries fallback source (from Phase 1)
    run final pass only
else:
    drain with live model (current behavior)
    no final pass
```

`runFinalPass` already accepts `liveEntries` as fallback for errored chunks — wire entries.jsonl records there.

### Files touched
- `src/finalize.ts` (conditional drain logic, ~20 lines)

---

## Phase 3 — Unify Whisper Stacks (Issue #5)

**Goal:** `import.ts` reimplements whisper invocation independently of `transcriber.ts`, including a duplicate argument list and a hardcoded binary finder that ignores `config.whisperBin`.

### New function in `transcriber.ts`

```typescript
export function resolveWhisperBin(config: Config): string {
  if (config.whisperBin && existsSync(config.whisperBin)) return config.whisperBin;
  const fallbacks = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
  return fallbacks.find(p => existsSync(p)) ?? config.whisperBin;
}
```

### Delete from `import.ts`

- `findWhisper()` — replace all callers with `resolveWhisperBin(config)`
- `runWhisper()` inner arg list — replace with a call to `transcribeChunk` (or a shared arg-builder)

The import path needs segment timestamps (uses `-oj`) while live uses `-otxt --no-timestamps`. Extract `buildWhisperArgs(config, wavPath, options)` that accepts a `format: "json" | "txt"` option so both paths share one arg list.

### Fix hardcoded whisper path in `cli.ts`

`checkSetup` (lines 537, 571) probes hardcoded paths instead of `config.whisperBin`. Replace with `resolveWhisperBin(config)`.

### Fix inline tilde expansion

`cli.ts:177` and `transcriber.ts:120-122` do `replace("~", HOME)` — replace with `expandPath()`.

### Files touched
- `src/transcriber.ts` (add `resolveWhisperBin`, `buildWhisperArgs`)
- `src/import.ts` (delete `findWhisper`, `runWhisper`, use shared helpers)
- `src/cli.ts` (fix `checkSetup` binary probe, fix tilde expansion)

---

## Phase 4 — Extract Recorder (Issue #4)

**Goal:** Move `startSession`'s lifecycle logic out of `cli.ts` into a testable `Recorder` class.

### New file: `src/recorder.ts`

```typescript
export class Recorder extends EventEmitter {
  constructor(session: Session, config: Config, captureProcess: ChildProcess) {}

  // Events
  on("transcribed", (source, index, text) => void)
  on("health-warning", (warning: HealthWarning) => void)
  on("auto-stop", (reason: AutoStopReason) => void)
  on("exit", () => void)

  start(): void          // starts pipeline + status interval + auto-stop checks
  stop(): Promise<void>  // stops capture, drains pipeline
  getStats(): Stats
  getSession(): Session
}
```

### `cli.ts` becomes thin wiring

`startSession` shrinks to: construct session → spawn capture process → create `Recorder` → wire keyboard/signal handlers to `recorder.stop()` → await exit event → promptTags → spawn finalizer.

All the closures (`shuttingDown`, `autoStopReason`, `opencodeRunning`, `statusInterval`, chunk counters) move into `Recorder` as class fields.

### Chunk counter fix (Issue #7)

Inside `Recorder`, maintain separate counters:
- `capturedChunks` (from capture stderr events) — display "captured"
- Use `pipeline.getStats()` for "transcribed"
- Lag = `capturedChunks - stats.totalDone`

### Files touched
- `src/recorder.ts` (new, ~150 lines)
- `src/cli.ts` (`startSession` shrinks from 420 to ~80 lines)

---

## Phase 5 — Session State Ownership (Issue #1)

**Goal:** Eliminate silent overwrites between parallel writers.

### After Phase 4 is done:

- **During recording**: only `Recorder` writes session.json (pipeline writes go through it)
- **After queued**: only `finalizeSession` writes

Concretely: remove `await writeSession(session).catch(() => {})` from `pipeline.ts`. Instead, `Pipeline` fires a callback on completion, and `Recorder` calls `writeSession` as the sole writer.

Suppress `appendEntry().catch(() => {})` in `cli.ts:190` — log to stderr instead.

### Files touched
- `src/pipeline.ts` (remove session writes, fire callback instead)
- `src/recorder.ts` (centralize session writes)

---

## Phase 6 — Move /tmp → ~/.meet/sessions (Issue #3)

**Goal:** Session dirs survive reboots.

### Change in `cli.ts` / `recorder.ts`

```typescript
const sessionDir = expandPath(`~/.meet/sessions/meet-${id}`);
```

### Change in `storage.ts`

`findStaleSessions()` currently reads `/tmp` — scan `~/.meet/sessions/` instead.

### Cleanup

After `status = "done"`, delete the session dir (WAVs are large). Keep `session.json` only, or move to a `~/.meet/completed/` index.

### Migration note

Old sessions in `/tmp` will still be found by `meet status` only if that /tmp dir still exists. No migration needed — they'll naturally expire.

### Files touched
- `src/cli.ts` or `src/recorder.ts` (session dir path)
- `src/storage.ts` (`findStaleSessions` scan path + cleanup after done)

---

## Verification

After each phase:

```bash
# Build
npm run build

# Type check
npm run lint

# Run tests
npm test

# Smoke test (requires hardware)
node dist/main.js doctor mic          # should pass in 12s
node dist/main.js start "Test"        # record 30s, verify transcript.md
cat /tmp/meet-*/entries.jsonl         # Phase 1: verify records appear
node dist/main.js status              # should show finalizing progress
```

Phase 1 regression: verify `meet finalize <dir>` recovers correctly from a session where `transcript.md` was deleted but `entries.jsonl` exists.

Phase 2 regression: measure wall-clock time from Ctrl+C to transcript ready — should be ~half for sessions with pending chunks.

---

## Files NOT touched

- `src/filters.ts`, `src/audio-metrics.ts`, `src/phrasebook.ts` — pure logic, no issues
- `src/tags.ts`, `src/opencode.ts` — no architectural issues
- `native/AudioCapture/` — only stderr protocol cleanup (Issue #9, minor, defer)
- All `*.test.ts` — add new tests alongside changes, don't modify existing tests
