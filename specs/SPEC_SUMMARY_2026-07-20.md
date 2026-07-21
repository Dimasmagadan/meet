# SPEC: Extractive Summary During Recording (Live Draft Pass)

**Date:** 2026-07-20 (revised twice: codebase review, then second-pass review of flush/config/testability gaps)
**Status:** Draft — codebase-verified, ready for implementation
**Owner:** Dmitrii Diakonov

---

## 1. Overview

One additive feature: a **lightweight extractive summary** generated **during recording**, with resource-aware throttling. No LLM inference, no cloud, no new native binary. This is the low-quality first tier of a future two-tier (extractive now + LLM later) summarization pipeline.

### Context

A review of `meet` against peers (Meetily, ownscribe, Anarlog) surfaced three gaps: (1) no meeting summaries, (2) no persistent cross-session speaker identity, (3) no RAG / post-call Q&A over external context. Of these:

- **Speaker identity** — already addressed within-session by `src/diarization.ts` + the AudioAnalysis binary (per `SPEC_SPEAKERS_2026-07-03.md`); cross-session fingerprinting is deferred (privacy + opt-in UX not yet designed).
- **RAG / Q&A** — partial: `src/opencode.ts` already exposes `runOpencodeQuestion` (the `a` hotkey during recording) and `runOpencodeIndex` (post-import `index.md`). Enriching this with external sources is deferred; it depends on a local vector store decision.
- **Summarization** — the real gap. This spec closes it with the cheapest viable v1.

### Decision

Performance is the top priority. The chosen approach is **extractive only during recording**, with **resource monitoring** that pauses and resumes the summarizer so it never competes with `whisper-cli`, the capture process, or other apps the user is running.

| Decision | Choice | Why |
|---|---|---|
| Algorithm | Extractive (TextRank + keyword cues) | ~50ms, CPU-only, no model download |
| Timing | During recording, incremental | User sees a rough draft immediately |
| LLM refine | **Out of scope for v1** | Deferred to a separate spec — runs post-finalize where it can't compete with live transcription |
| Resource handling | Poll + pause + resume | Honors concurrent whisper-cli and user apps |

### Goals
- Produce a rolling `summary.md` next to `transcript.md` while recording.
- Zero perceptible impact on the live transcription pipeline (target <1% CPU, <10MB RAM).
- Graceful degradation: if the machine is busy, the summarizer pauses silently and catches up later; the transcript is never affected.
- Output is good enough to skim — not polished. Quality is explicitly a non-goal for v1.

### Non-goals (v1)
- No LLM-based summarization (local or cloud). No model downloads.
- No action-item/decision extraction with semantic understanding — only regex/keyword heuristics.
- No cross-meeting aggregation or dashboard integration (beyond a stat tile).
- No summary for `meet transcribe` file imports (single-shot; the existing `index.md` via opencode already covers imports).
- No persistence of "which sentences were already summarized" across sessions — the rolling summary is recomputed from the live pipeline results on each pass.

---

## 2. Architecture

### 2.1 Where it hooks in

The live transcription callback in `src/recorder.ts` (`initPipeline`, line 80) already fires once per finalized chunk with `(source, index, text)`. This is the only integration point:

```
existing: chunk transcribed → appendEntry(transcript.md) → attention check
NEW:                       └→ SummaryScheduler.maybeRun()
                                ├─ check resource pressure
                                ├─ if OK: recompute summary from live entries → write summary.md
                                └─ if overloaded: mark dirty, schedule retry
```

The summarizer reads **live in-memory entries** via the same pattern the rest of the recorder uses — `entriesFromSession(session, pipeline.getResults())` (see `recorder.ts:104, 107` and `finalize.ts:374`). It must NOT read `entries.jsonl` directly: that file is written asynchronously in `pipeline.ts:213` *after* the chunk callback fires, so a direct read systematically misses the most recent chunk.

This means:
- Crash-safety: `summary.md` is a derived artifact; on crash it simply regenerates on next start from the (recovered) live pipeline state. It is never the source of truth.
- No new durable state: nothing to migrate, no new lock, no schema change to `session.json`.
- Idempotent: re-running on the same live entries produces the same output.
- A new output file (`summary.md`) is produced, next to `transcript.md` in the meeting output dir. This is a derived artifact, not session state.

### 2.2 New module: `src/summary.ts`

Pure logic, fully testable without the filesystem:

```ts
import type { TranscriptEntry } from "./types.js";

export interface SummaryResult {
  windowStartIndex: number;     // first chunk included
  windowEndIndex: number;       // last chunk included
  keyPoints: TranscriptEntry[]; // top-N scored entries (full entries, not just text)
  candidateActions: TranscriptEntry[]; // entries matching action-item regex
  participants: string[];       // ["Me", "Others" | "Speaker 1", ...]
  generatedAt: string;          // ISO timestamp
}

// TextRank over sentence-split entries within [startIndex, endIndex].
// Stops early if entry count < MIN_ENTRIES_FOR_SUMMARY (e.g. 8).
export function extractSummary(
  entries: TranscriptEntry[],
  options?: { topN?: number; minEntries?: number; maxWindowEntries?: number },
): SummaryResult

// Renders a SummaryResult to the markdown written to summary.md.
export function formatSummaryMarkdown(
  result: SummaryResult,
  title: string,
  startedAt: string,
): string
```

**Algorithm (v1 — deliberately simple):**

1. **Window**: take the last `maxWindowEntries` entries (default 200) from the input — a sliding window, not a grow-only accumulator.
2. **Sentence split**: break each entry's text on `.!?` plus Russian `…`/`—`. Keep sentence → entry mapping so we can attribute speakers and timestamps.
3. **Tokenize & normalize**: lowercase, strip punctuation, drop Russian + English stopwords (built-in list, ~150 words, no npm dep).
4. **Score**: TextRank-style — build a sentence similarity graph (bag-of-words cosine), run `TEXTRANK_ITERATIONS = 20` iterations of power iteration on the PageRank vector. For a 200-entry window (~600 sentences) this is <50ms on an M2.
5. **Select**: take the top N entries (default 5) by their best sentence score, re-sort chronologically. Returning whole `TranscriptEntry` objects (not raw text) keeps timestamps and speaker labels attached.
6. **Action-item heuristic**: regex over raw text for `/(нужно|надо|сделаем|сделать|дедлайн|deadline|todo|задача|вернёмся|обсудим|до \|к\s+\d)/i`. Returns the matching entries (high recall, low precision — these are *candidates*).
7. **Participants**: derived from `entry.source === "mic" ? "Me" : "Others"` (we do **not** wait for diarization — that's finalize-only). During live recording, `entry.speaker` is always undefined; the post-finalize rewrite path (§2.8) does not change this.

### 2.3 New module: `src/system-monitor.ts`

macOS-specific, no native deps:

```ts
export interface ResourcePressure {
  cpuLoad1min: number;          // raw 1-min loadavg (e.g. 2.31)
  cpuCores: number;             // os.cpus().length, for the status line ratio
  freeMemoryMb: number;         // from vm_stat page counts
  whisperRunning: boolean;      // pgrep whisper-cli (cheap, cached 5s)
  overloaded: boolean;          // cpuLoad1min > threshold || freeMemory < MEM_THRESHOLD_MB
  reason: string | null;        // human-readable for the status line
}

export function getSystemPressure(): Promise<ResourcePressure>
```

**Implementation notes:**
- **CPU loadavg source**: `sysctl -n vm.loadavg`. This prints `{ (5, 10, 60) = 1.23, 1.45, 1.50 }`; parse the second float (1-min). This is the same source `uptime` reads. Threshold is a raw loadavg value (`summaryCpuThresholdLoad`), NOT a percentage — loadavg is not a percentage. The status line renders it as `cpu 2.3/8c` for clarity.
- **Threshold choice.** The default of 6 (§2.5) was picked empirically for an 8-core M2 Pro: it leaves headroom for one whisper-cli burst (loadavg ~1-2) plus a browser tab or two before pausing the summarizer. The value is a **static literal** in `DEFAULT_CONFIG` (consistent with every other threshold in the file). On machines with very different core counts the user tunes it via `~/.meet/config.json`. We deliberately do NOT compute `os.cpus().length * 0.75` at config-load time — `DEFAULT_CONFIG` is a frozen literal object and injecting runtime values would break that invariant.
- **Memory**: `vm_stat` for free + inactive pages × page size (4096). One `execFile`, one regex. Fail-open: on parse error, treat memory as "unknown" and don't block on it.
- **`whisperRunning`**: `pgrep -f whisper-cli`. Result is cached for 5s so repeated checks in the same window don't spawn multiple processes. On any error (binary missing, non-zero exit), treat as `false` — never block summarization on this signal alone (whisper-cli is gated by the CPU threshold anyway).
- **Irony acknowledged.** `getSystemPressure()` spawns `sysctl` + `vm_stat` (+ cached `pgrep`) every catch-up tick (every 30s while overloaded). This is negligible cost (~10ms total, three short-lived processes), but it does mean we spawn subprocesses precisely when the machine is already loaded. Acceptable: the alternative (a native addon reading `host_statistics64`) is out of scope for v1 and the cost is dominated by the whisper-cli burst we're protecting against.
- **Latency caveat.** Loadavg is a 1-min lagging signal. After a whisper-cli burst clears, the summarizer may stay paused for up to a minute. At our 2-min cadence this mostly washes out, but don't expect crisp sub-second pause/resume.
- All thresholds are config keys (§2.5) so they can be tuned per machine.

### 2.4 Scheduler (inside `src/summary.ts`)

The scheduler is a small class owned by `Recorder`, not a global — it dies with the session:

```ts
export class SummaryScheduler {
  constructor(opts: {
    session: Session;
    outputFile: string;          // <meetingDir>/summary.md
    intervalChunks: number;      // run every N new chunks (default 8 = ~2min)
    catchupIntervalMs: number;   // retry interval while overloaded (default 30_000)
    warn: (msg: string) => void;
  })

  // Called from recorder's transcribe callback on every chunk.
  onChunk(source: "mic" | "sys", index: number): void

  // Called on shutdown to force a final summary flush.
  flush(): Promise<void>

  // Injected at construction so tests can substitute a fake. Production
  // wires this to () => getSystemPressure() from system-monitor.ts.
  getPressure: () => Promise<ResourcePressure>

  // Injected so the scheduler never touches Pipeline directly.
  // Production wires this to () => entriesFromSession(session, pipeline.getResults()).
  getEntries: () => TranscriptEntry[]
}
```

**Behavior — chunk-driven, timer-driven, and flush paths are explicitly separate:**

- **Chunk-driven (hot path).** `onChunk` increments an internal counter. When the counter reaches `intervalChunks`, it calls `maybeRun()` and resets the counter. If a run is already in flight (tracked via `inFlightRun: Promise<void> | null`), the counter is reset but no new run starts (coalescing).
- **`maybeRun()`** asks `getPressure()`. If `overloaded`, logs once via `warn` (same `createWarnOnce` pattern used by `Pipeline` and `Recorder`), sets `dirty = true`, and returns. If not overloaded, calls `getEntries()`, runs `extractSummary`, writes `summary.md` atomically (`.tmp` → `rename`, per project convention), clears `dirty`. Stores its own Promise in `inFlightRun` for the duration of the run so callers can await completion.
- **Empty-window early-out.** If `getEntries().length < summaryMinEntries`, `maybeRun()` returns without writing `summary.md` (file does not exist yet), without setting `dirty`, and without starting the catch-up timer. The status line shows `summary: waiting`. Once `MIN_ENTRIES` is reached, the next triggered run writes `summary.md` (header + footer + key points). Do NOT pre-create an empty stub: it would be picked up by file-globbing tools (and `meet list`) as if it were real output.
- **Timer-driven (catch-up).** When `dirty` becomes true, a single timer is started (if not already running) that fires every `catchupIntervalMs`. Each tick calls `maybeRun()`. The timer self-cancels as soon as `dirty` clears. This is the *only* retry path — once overloaded, subsequent `onChunk` calls just keep incrementing the counter and do nothing else until either the counter hits `intervalChunks` again (then `maybeRun` runs once, may still be overloaded) or the timer fires.
- **`flush()`** is the shutdown path. It MUST NOT be defeated by the coalescing guard:
    1. Cancel the catch-up timer.
    2. If `inFlightRun` is non-null, `await` it to completion first.
    3. Call `maybeRun()` once, ignoring the `intervalChunks` gate. If overloaded at shutdown, still attempt the run (user is waiting; better to try than silently drop).
    4. Always resolve — never throws into the recording path.

  Rationale: if `flush()` only called `maybeRun()` and a chunk-driven run happened to be in flight, the coalescing guard would no-op `flush()` and the last partial window would be silently dropped — defeating the entire point of `flush()` (§2.7).
- **Fail-open.** Any thrown error is caught, warned once via `warn`, and sets a `disabled = true` flag. All subsequent `onChunk`/`flush` calls are no-ops. The summarizer must never propagate errors into the recording path.

### 2.5 Config additions (`src/types.ts` `DEFAULT_CONFIG`)

| Key | Default | Purpose |
|-----|---------|---------|
| `summaryEnabled` | `true` | Master switch |
| `summaryIntervalChunks` | `8` | Run every N chunks (~2 min at 15s chunks) |
| `summaryTopN` | `5` | Key points per window |
| `summaryWindowMaxEntries` | `200` | Cap on entries considered per run (sliding window) |
| `summaryMinEntries` | `8` | Don't summarize below this many entries |
| `summaryCpuThresholdLoad` | `6` | Pause when 1-min loadavg exceeds this (raw value, ~0.75 × 8 cores on M2 Pro) |
| `summaryMemThresholdMb` | `768` | Pause below this free memory |
| `summaryCatchupIntervalMs` | `30_000` | Retry interval while overloaded |

Eight keys, all under the `summary*` prefix for discoverability. No existing config is renamed.

**Why `summaryCpuThresholdLoad` is a raw loadavg, not a percentage.** Loadavg is a count of runnable processes averaged over time; calling it a "percentage" requires picking a denominator (CPU count) and implies 100% is saturated, which isn't true on multicore machines. The default of 6 is a **static literal** chosen for an 8-core M2 Pro: it leaves headroom for one whisper-cli burst (loadavg ~1-2) plus a browser tab or two before pausing the summarizer. We do not compute `os.cpus().length * 0.75` at config-load time because `DEFAULT_CONFIG` is a frozen literal object (every other threshold in the file follows this rule). On non-8-core machines the user tunes it via `~/.meet/config.json`.

**Why `summaryWindowMaxEntries` is separate from `summaryMinEntries`.** Min is a floor (skip runs when the meeting is just starting). Max is a ceiling (bound CPU on long meetings). Different concerns, different defaults.

### 2.6 Output format

`summary.md` is written to the **meeting output dir** (next to `transcript.md`), so it survives session-dir cleanup and is immediately visible to `meet list`:

```markdown
# Weekly Standup — Summary (draft)

**Generated:** 14:47:30 · **Window:** 14:30:00 – 14:47:15 · **Chunks:** 68

## Key points

**[14:31:00] Me:** Квартальные цели на уровне прошлого года, но нужно ускорить релиз.
**[14:33:45] Others:** Бэкенд готов к выкатке в среду, фронт отстаёт на два дня.
**[14:38:20] Me:** Берём риск на себя, катим в среду без полного регресса.
**[14:42:10] Others:** По бюджету: укладываемся, но найм задерживается до сентября.
**[14:45:00] Me:** Итог — выкатка среда, ретро в пятницу.

## Candidate action items

**[14:33:45] Others:** …отстаёт на два дня.
**[14:42:10] Others:** …найм задерживается до сентября.
**[14:45:00] Me:** …ретро в пятницу.

## Participants

Me, Others

---

> Draft produced locally by extractive summarization. Final, higher-quality summary can be generated on demand with `meet summary --full` (post-finalize, future spec).
```

**Rendering rules:**
- Each line in "Key points" and "Candidate action items" uses the **exact same `formatEntry()` shape as `transcript.md`** (`assembler.ts:36`): `**[timestamp] Label:** text`. This is deliberate — copy-pasting a line from `summary.md` into a search of `transcript.md` matches verbatim. A shared helper (e.g. `formatSummaryEntry`) should be extracted rather than re-implementing the format.
- `Label` is always `Me` / `Others` during recording, derived from `entry.source` (no diarization runs live). If `entry.speaker` is present (only after finalize re-write — see §2.8), it is preserved.
- The footer block is constant across every version of every draft — it sets expectations and advertises the future `--full` flag.
- **Empty state.** Before the first successful run, `summary.md` does NOT exist. The status line shows `summary: waiting` (or omits the suffix — TBD in implementation). Once the first run completes, the file is created. Do NOT pre-create an empty stub: it would be picked up by file-globbing tools (and `meet list`) as if it were real output.

### 2.7 Recorder integration (`src/recorder.ts`)

Minimal, additive change. The scheduler is constructed in the `Recorder` constructor and torn down on every exit path. There are **three** shutdown paths in `recorder.ts` and each must `await flush()` before exiting:

| Path | Method | Current exits via | Where `flush()` goes | Drain semantics |
|---|---|---|---|---|
| `q` / Ctrl-C / SIGTERM | `shutdown()` (line 278) | `process.exit(0)` at line 292 | Before `promptTags()` | **Does NOT drain pipeline.** `flush()` sees only already-transcribed chunks. Queued-but-untranscribed tail chunks are absent from both `transcript.md` and `summary.md` — consistent behavior. |
| `s` (stop + finalize foreground) | `stopAndFinalizeForeground()` (line 301) | `process.exit(0)` at line 326 | After `pipeline.stop()` drains (line 314) | **Drains pipeline.** `flush()` sees the drained tail. |
| `n` (next meeting) | `nextMeeting()` (line 335) | `resolveRun?.()` at line 349 | Before `cleanup()` | Does NOT drain pipeline (same as `q`). |

Sketch:

```ts
import { dirname, join } from "node:path";
// ...

// constructor (after this.attention = ...):
this.summaryScheduler = config.summaryEnabled
  ? new SummaryScheduler({
      session,
      // Use dirname + join, NOT a regex replace. The regex variant returns
      // the unchanged path on no-match, which would clobber transcript.md.
      // finalize.ts:443 already uses this dirname pattern.
      outputFile: join(dirname(session.outputFile), "summary.md"),
      intervalChunks: config.summaryIntervalChunks,
      catchupIntervalMs: config.summaryCatchupIntervalMs,
      getEntries: () => entriesFromSession(this.session, this.pipeline.getResults()),
      getPressure: () => getSystemPressure(),
      warn: this.warn,
    })
  : null;

// in initPipeline's transcribe callback, after appendEntry (line 100):
this.summaryScheduler?.onChunk(source, index);

// in each shutdown path (see table above), before the exit/cleanup:
await this.summaryScheduler?.flush();

// in startStatus() status line, append (only when interesting):
//   " | summary: ok" | " | summary: paused (cpu 2.3/8c)" | " | summary: waiting" | ""
```

The status line change is the only user-visible UI in v1 (apart from `summary.md` itself). No new hotkey, no new CLI subcommand.

**Why all three paths need flush.** Without it, the last partial window (since the last `intervalChunks` boundary) is silently dropped on every exit. The `s` and `q` paths are the most common exit shapes; `n` matters for back-to-back meeting workflows.

**What "tail" means per path.** On `s`, `flush()` reflects the fully drained meeting including chunks that were still in the whisper queue at shutdown time. On `q` and `n`, `flush()` reflects only chunks that had already finished transcribing when the user hit the key — the queued tail is absent. This matches `transcript.md`'s existing behavior (the `q` path has always dropped the queued tail), so the summary remains consistent with the transcript on every path.

**Testability caveat.** `recorder.ts` calls `process.exit(0)` directly at lines 292 and 326, plus uses raw-mode stdin and signal handlers. This makes the recorder genuinely hard to unit-test. Asserting "flush awaited in all three paths before exit" via a unit test requires either:
- Refactoring `process.exit` behind an injectable seam (e.g. `private exit: (code: number) => never = process.exit`), or
- Spawning a real `meet start "Test"` subprocess and asserting `summary.md` exists at termination (integration test).

Phase 2's checkpoint uses the **integration** approach (spawn real subprocess). The structural refactor is optional and explicitly out of scope for v1; `recorder.test.ts` is not created in Phase 2. See §4 for the test plan.

### 2.8 Finalize interaction

`finalizeSession` in `src/finalize.ts` **does not regenerate `summary.md` and does not rewrite speaker labels in it.** Rationale:
- The finalize pass already rewrites `transcript.md` with `Speaker N` labels and talk-time.
- Re-summarizing on the finalized transcript is the job of the *future* LLM refine pass, not this v1.
- Regenerating labels in `summary.md` would require re-running TextRank or maintaining a chunk→speaker map the live summarizer never had. Out of scope.

The single post-finalize action is a **header note append** — if `summary.md` exists next to `transcript.md`, finalize appends one line:

```
> Note (post-finalize): the transcript has been rewritten with Speaker N labels and talk-time. This draft summary still uses Me/Others from the live recording; run `meet summary --full` (future) for an updated version.
```

Implementation: in `finalize.ts:443-446` (where `speakers.json` and `transcript.md` are written), add a conditional append to `summary.md` if it exists. Atomic write not needed (append-only, single line).

This keeps the draft honest without deleting user-visible output and without the cost of a re-summarize pass.

---

## 3. Implementation plan

Ordered so each phase ships independently and is verifiable on a real meeting before the next.

### Phase 1 — Pure logic + tests
1. `src/summary.ts`: `extractSummary`, `formatSummaryMarkdown`, stopwords list, action-item regex, sliding window cap.
2. `src/summary.test.ts`: sentence split (en/ru), TextRank determinism on a fixture, action-item regex cases, participant extraction, `MIN_ENTRIES` early-out, `MAX_WINDOW_ENTRIES` slicing, top-N ordering, timestamp/speaker attribution preserved through `TranscriptEntry[]`.
3. `src/system-monitor.ts` + `src/system-monitor.test.ts`: mock `execFile`, assert thresholds, `overloaded` flips correctly under various pressure scenarios, parse-tolerance on malformed `sysctl`/`vm_stat` output, fail-open behaviour.
   - **Checkpoint:** `npm run build && node --test dist/summary.test.js dist/system-monitor.test.js` green.

### Phase 2 — Scheduler + recorder wiring
1. `SummaryScheduler` class inside `src/summary.ts`: chunk-driven counter, timer-driven catch-up, dependency-injected `getEntries`/`getPressure` for testability, atomic `summary.md` writes, fail-open on any error.
2. `src/types.ts`: add the eight `summary*` config keys with defaults.
3. `src/recorder.ts`: construct scheduler, call `onChunk` from the transcribe callback, `await flush()` on **all three** shutdown paths (§2.7), status-line suffix.
4. `src/finalize.ts`: append the post-finalize note to `summary.md` if it exists.
   - **Checkpoint:** 15-min real recording produces `summary.md` that updates every ~2 min; `cat summary.md` shows plausible key points using the same `**[ts] Label:**` format as `transcript.md`; transcript.md unchanged; shutdown paths each produce a final flush.

### Phase 3 — Polish & docs
1. Update `AGENTS.md` module list + `PLAN.md` post-MVP pointer.
2. `meet doctor`: print `summaryEnabled` + thresholds (no audio test needed).
3. README note: "summary.md is a low-quality live draft; a refined pass is planned."
4. `--no-summary` CLI flag on `meet start` (§6 open question #5).

### 3.1 Validation (separate from implementation phases)

Manual stress tests, run after Phase 2 is checkpoint-green. Not a build phase — these verify the runtime invariants under real load:

| Test | Setup | Expected |
|---|---|---|
| CPU pressure | `yes > /dev/null &` in 2 terminals during recording | Summarizer pauses, warns once, status shows `summary: paused (cpu 7.8/8c)`, resumes after kill |
| Memory pressure | ramdisk fill script drops free mem < 768MB | Same pause/resume, status shows `summary: paused (mem 612MB)` |
| Whisper mid-chunk kill | `pkill -f whisper-cli` during recording | Summarizer unaffected — its only whisper signal is informational, not gating |
| Long meeting | 90-min synthetic recording (>360 chunks) | TextRank stays <100ms per run; window slicing holds at 200 entries; no memory growth across runs |
| Three exit paths | Spawn `meet start "Test"` against a fixture audio source; send `q`, `s`, `n` to stdin in three separate runs | Each run produces a `summary.md` reflecting entries up to the shutdown point; on `q`/`n` the queued tail is absent from BOTH `summary.md` and `transcript.md` (consistency); on `s` the drained tail is present in both |

---

## 4. Testing

Node tests (`node:test`) for pure logic and the scheduler. Tests must never spawn `whisper-cli`, hit the filesystem in unmocked ways, or call real `execFile`. Inject `getEntries` and `getPressure` fakes.

| File | Coverage |
|---|---|
| `summary.test.ts` | `extractSummary` on 8/50/200/500-entry fixtures; deterministic output given same input; `topN` clamp; `MIN_ENTRIES` early-out returns empty `keyPoints`/`candidateActions`; `MAX_WINDOW_ENTRIES` slices the tail correctly (500 → last 200); action-item regex matches `нужно/надо/сделаем/deadline/до пятницы`; participants derive from `entry.source` (`Me`/`Others`); `source === "file"` entries fall through to `Others` (harmless — recording never emits `file`); ru + en sentence splits; `formatSummaryMarkdown` header shape, `**[ts] Label:**` line format identical to `assembler.ts:formatEntry`, footer block present, empty result renders header + footer only. |
| `system-monitor.test.ts` | `getSystemPressure` parses a captured `sysctl vm.loadavg` fixture and `vm_stat` fixture; malformed output → fail-open (`overloaded = false`, `reason` populated); `whisperRunning` observable behaviour: rapid successive calls within 5s do not spawn >1 `pgrep` (verify via execFile call count, not internal cache state); thresholds flip `overloaded` correctly across boundary values; `reason` populated with the failing metric. |
| `summary-scheduler.test.ts` (new) | **Chunk-driven path**: counter triggers run at `intervalChunks`, coalesces overlapping runs (no second `getEntries` call while one is in flight). **Timer-driven path**: timer starts only when `dirty`, self-cancels on successful run. **`flush()` semantics**: (a) awaits any in-flight run before running its own; (b) ignores the `intervalChunks` gate; (c) runs even if `getPressure` reports overloaded; (d) always resolves. **Empty-window early-out**: when `getEntries().length < minEntries`, `maybeRun` does NOT write the file, does NOT set `dirty`, does NOT start the timer. **Fail-open**: any thrown error from `getEntries`/`getPressure`/write sets `disabled` and subsequent `onChunk`/`flush` are no-ops. |
| `finalize.test.ts` (additions) | Post-finalize note is appended to `summary.md` only when the file exists; absent file is not created; existing note is not duplicated on re-finalize. |

**Recorder integration — integration test, not unit test.** `recorder.ts` does not have a unit-test file today, and the three shutdown paths each call `process.exit(0)` directly (`recorder.ts:292`, `:326`) and use raw-mode stdin + signal handlers. Asserting "flush awaited in all three paths before exit" via a unit test would require refactoring `process.exit` behind an injectable seam, which is out of scope for v1.

Instead, Phase 2's checkpoint uses a **subprocess integration test**:
- Spawn `meet start "Test"` against a fixture audio source.
- Send `q` / `s` / `n` to its stdin in three separate runs.
- Assert `summary.md` exists in the output dir after each run exits, and reflects entries up to the shutdown point (per the drain-semantics table in §2.7).

This is added to §3.1's Validation table. A `recorder.test.ts` unit-test file is **not** created in v1.

No Swift changes; no new native binary.

---

## 5. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| TextRank O(n²) on a long meeting (400+ entries) | CPU spike during recording | Sliding window capped at `summaryWindowMaxEntries` (default 200); `summaryIntervalChunks` prevents re-running too often; every run is gated by `getSystemPressure()` |
| `sysctl vm.loadavg` / `vm_stat` parsing varies across macOS versions | Wrong pressure reading → never/always pause | Parser is regex-tolerant; on parse error `overloaded = false` with a warn-once (fail toward "keep summarizing" since the transcript is the critical path) |
| `pgrep` not in PATH on exotic setups | `whisperRunning` always false | `pgrep` is part of macOS base; on any error treat as `false`. Whisper detection is informational only — CPU threshold is the real gate. |
| Live `entriesFromSession` call allocates a fresh array each run | Minor GC pressure | Bounded by `summaryWindowMaxEntries` (200); called every ~2 min, not per chunk; well below measurable threshold |
| Forgetting `flush()` in one of the three shutdown paths | Last window silently dropped | §3.1 validation table covers each path via subprocess integration test; `flush()` semantics in §2.4 explicitly await in-flight runs to defeat the coalescing guard |
| Summary distracts user from the real transcript | UX confusion | Constant footer in every `summary.md` labelling it as a draft; no mention of summary in `transcript.md`; `meet list` shows them as sibling files |
| User expects LLM quality | Disappointment | README + `meet doctor` explicitly call this a draft tier; the footer advertises the future `--full` flag |
| Status-line update races with stdout writes from other paths | Garbled terminal output | Append suffix only in `startStatus()`'s tick; clear/rewrite on each tick (existing pattern); never write to stdout from `onChunk`/`flush` paths directly |

---

## 6. Open questions (non-blocking, defaults chosen)

1. Should the summary window slide (last N entries) or grow (whole session so far)? **Slide (chosen)** — bounded work, reflects recent context, matches "rolling draft" intent.
2. Should action items deduplicate across runs? **No (v1)** — candidates are cheap, dedup is the LLM's job later.
3. Should `summary.md` be committed alongside `transcript.md` in any future sync feature? **Yes** — it's a first-class output, treated identically.
4. Should the resource check run before the first summary (which might be early in the meeting when load is low)? **Yes** — always check, never assume.
5. Should we expose `--no-summary` on `meet start`? **Yes** — small ergonomic win, trivial to add, gives users an escape hatch if the summarizer ever misbehaves on their machine.

---

## 7. Future work (explicitly deferred)

- **LLM refine pass** (`meet summary --full`, post-finalize): separate spec. Will use a local quantized model via the existing AudioAnalysis Swift package or `llama.cpp`; runs under the global final-pass lock so it never competes with live recording.
- **Cross-session speaker fingerprints**: separate spec; needs opt-in UX and embedding storage design.
- **RAG over past meetings + external notes**: separate spec; needs a vector-store decision (ChromaDB vs. sqlite-vec vs. in-memory).
- **Summary templates** (standup / interview / sales): deferred until LLM pass exists, since templates need paraphrasing to be useful.
