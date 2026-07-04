# SDD Spec: Speaker Diarization, Talk-Time Stats, Parakeet A/B Pass

**Date:** 2026-07-03
**Status:** Draft — approved direction, pending implementation
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Three additive features to the finalization stage. Live recording path is untouched.

| # | Feature | Outcome |
|---|---------|---------|
| F1 | Speaker diarization (FluidAudio, final pass only) | "Others" entries in transcript.md become "Speaker 1", "Speaker 2", … |
| F2 | Talk-time stats | Per-speaker talk time (minutes + %) in transcript footer, `speakers.json` artifact, dashboard aggregate |
| F3 | Parakeet-TDT-0.6B-v3 A/B pass | After the whisper final pass, a second full pass with Parakeet writes `transcript.parakeet.md` for manual quality comparison |

### Goals
- Split system-audio ("Others") entries into per-person labels. Mic stays "Me".
- Zero impact on live recording performance (everything runs in finalize; FluidAudio models run on the Apple Neural Engine).
- Fail-open everywhere: any failure in F1/F2/F3 degrades to today's behavior with a warning, never blocks finalization.
- A/B artifacts are side-by-side and same-shaped (same entries/timestamps layout) so quality comparison is a plain diff/read.

### Non-goals (v1)
- No live/streaming diarization.
- No persistent speaker identity across meetings (voice fingerprints / naming people) — the FluidAudio embedding API makes this possible later; design leaves the door open via `speakers.json`.
- No splitting of a single 15s chunk into multiple speaker entries (chunk = one label, majority-overlap wins).
- No diarization for `meet transcribe` file imports (future work).
- No automatic winner selection in the A/B — user compares manually and flips config.

---

## 2. Architecture

### 2.1 New Swift executable: `AudioAnalysis`

A second executable target in the existing `native/AudioCapture` Swift package (same repo, same build), depending on the [FluidAudio](https://github.com/FluidInference/FluidAudio) SPM package. Kept separate from `AudioCapture` so the capture binary's CLI interface, size, and permissions are unchanged.

```
native/AudioCapture/
  Package.swift                     # + FluidAudio dependency, + AudioAnalysis target
  Sources/AudioCapture/             # unchanged
  Sources/AudioAnalysis/
    main.swift                      # ArgumentParser root with subcommands
    DiarizeCommand.swift            # diarize subcommand
    TranscribeCommand.swift         # Parakeet ASR subcommand
    ModelsCommand.swift             # model download/warmup for `meet setup`
```

Node ↔ Swift boundary stays process + JSON (same philosophy as whisper-cli): Node spawns the binary via `execFile`, gets JSON on stdout. No streaming protocol needed — finalize is batch.

**CLI contract:**

```
AudioAnalysis diarize --input <concat.wav> [--min-active-frames N]
  → stdout JSON: { "segments": [ { "start": 0.0, "end": 12.4, "speaker": "S1" }, ... ],
                   "speakerCount": 2, "durationMs": 1234 }

AudioAnalysis transcribe --input <chunk.wav>
  → stdout JSON: { "text": "...", "durationMs": 456 }
  (Parakeet v3 auto-detects language; ru is in its 25 supported languages)

AudioAnalysis models --ensure
  → downloads/verifies CoreML models (diarizer + parakeet), exit 0 when ready
  → stdout JSON: { "diarizer": "ok", "asr": "ok", "cacheDir": "..." }
```

**Implementation notes (verify against FluidAudio `Documentation/API.md` at implementation time):**
- Diarizer: `DiarizerModels.downloadIfNeeded()` → `DiarizerManager` → `performCompleteDiarization(samples, sampleRate: 16000)`. Our WAVs are already 16kHz mono 16-bit PCM — convert Int16 → Float and feed directly, no resampling.
- ASR: `AsrModels.downloadAndLoad()` → `AsrManager.transcribe(samples)` with the `parakeet-tdt-0.6b-v3-coreml` model.
- Models auto-download from HuggingFace on first use into FluidAudio's cache dir. `models --ensure` exists so `meet setup` triggers the download explicitly instead of surprising the user mid-finalize. If models are missing at finalize time and download fails (offline), F1/F3 warn and skip.
- macOS 14+ requirement matches the package's existing `platforms: [.macOS(.v14)]`.

### 2.2 Finalize pipeline changes (`src/finalize.ts`)

New steps slot in **after** the whisper final pass and **before** `rewriteMarkdown` / session-dir cleanup (the `rm` at finalize.ts:311 deletes all WAVs — everything below needs them):

```
existing: stop pipeline → final whisper pass → entries[]
NEW  (1): diarize                                    [phase: "diarize"]
          - concat sys-*.wav → sys-concat.wav (session dir, temp)
          - AudioAnalysis diarize → segments
          - assign speaker per sys entry (majority overlap)
NEW  (2): talk-time stats
          - compute from segments + mic entries
          - write speakers.json to MEETING OUTPUT dir (survives cleanup)
          - append "## Talk Time" section to transcript.md
existing: rewriteMarkdown (now with Speaker N labels)
NEW  (3): parakeet A/B pass                          [phase: "ab"]
          - per-chunk AudioAnalysis transcribe (same chunk loop as final pass)
          - same speaker labels + timestamps as main transcript
          - write transcript.parakeet.md + ab-report.json to output dir
existing: session.status = done → rm sessionDir
```

`FinalizeProgress.phase` union gains `"diarize"` and `"ab"` (`src/types.ts:13`). The global final-pass lock stays held through the Parakeet pass (it is also a heavy compute pass; one at a time system-wide).

### 2.3 New module: `src/diarization.ts`

Pure-logic module (testable without the Swift binary):

```ts
export interface DiarSegment { start: number; end: number; speaker: string }

// Concatenate sys chunks in index order; returns offset map for time translation.
// Chunk durations read from WAV headers (last chunk is shorter; silence-gated
// chunks still exist on disk and are included so offsets stay truthful).
// Missing indices are skipped — the offset map, not adjacency, defines time.
export async function concatSysChunks(sessionDir: string):
  Promise<{ wavPath: string; offsets: Map<number, { start: number; end: number }> }>

export function runDiarizer(config: Config, wavPath: string): Promise<DiarSegment[]>

// Majority-overlap assignment: for each sys entry, its chunk's [start,end] in
// concat time is intersected with segments; speaker with max overlap wins.
// Overlap below minOverlapRatio (default 0.3) → no label (renders as "Others").
// Speakers renumbered "Speaker 1", "Speaker 2", … by first appearance in time.
export function assignSpeakers(
  entries: TranscriptEntry[],
  segments: DiarSegment[],
  offsets: Map<number, { start: number; end: number }>,
  minOverlapRatio?: number,
): TranscriptEntry[]
```

### 2.4 New module: `src/talk-time.ts`

```ts
export interface TalkTimeStats {
  totalSeconds: number;                  // meeting duration
  speakers: Array<{
    label: string;                       // "Me" | "Speaker 1" | ...
    seconds: number;
    percent: number;                     // of total speech time (not wall clock)
  }>;
}

// "Me": sum of diarization-independent mic activity — count of mic chunks with
// rmsDb >= micRmsThresholdDb (from entries.jsonl records) × chunkDuration.
// "Speaker N": sum of that speaker's diarization segment durations.
// When diarization is disabled/failed: two rows, "Me" and "Others"
// (sys computed the same chunk-counting way).
export function computeTalkTime(...): TalkTimeStats

export function formatTalkTimeSection(stats: TalkTimeStats): string
// ## Talk Time
// - Me: 12m 30s (42%)
// - Speaker 1: 14m 15s (48%)
// - Speaker 2: 3m 00s (10%)
```

### 2.5 Data model & format changes

**`TranscriptEntry`** (`src/types.ts`) gains an optional field — no migration needed:

```ts
export interface TranscriptEntry {
  source: "mic" | "sys" | "file";
  chunkIndex: number;
  timestamp: string;
  text: string;
  speaker?: string;   // NEW: "Speaker 1" etc. Only set on sys entries when diarized.
}
```

**Markdown format** (`src/assembler.ts` `formatEntry`): sys entries render `entry.speaker ?? "Others"`:

```
**[14:03:15] Me:** ...
**[14:03:30] Speaker 1:** ...
**[14:03:45] Speaker 2:** ...
**[14:04:00] Others:** ...        ← unlabeled/ambiguous sys entry, unchanged fallback
```

**Back-compat:** `parseTranscriptEntries` regex (`assembler.ts:84`) changes from `(Me|Others)` to `(Me|Others|Speaker \d+)`; any non-"Me" label maps to `source: "sys"` and is preserved into `speaker` when it matches `Speaker \d+`. Old transcripts keep parsing.

**`speakers.json`** — written to the meeting **output** dir (next to transcript.md, survives session cleanup):

```json
{
  "version": 1,
  "sessionId": "abc123",
  "diarization": { "ok": true, "speakerCount": 2, "binaryMs": 1234 },
  "segments": [ { "start": 0.0, "end": 12.4, "speaker": "Speaker 1" } ],
  "entryAssignments": [ { "chunkIndex": 3, "speaker": "Speaker 1", "overlapRatio": 0.92 } ],
  "talkTime": { "totalSeconds": 1800, "speakers": [ ... ] }
}
```

`version` + raw segments are kept so a future "name this speaker / voice fingerprints" feature can re-map labels without re-running diarization.

**`ab-report.json`** — output dir, only when F3 runs:

```json
{
  "date": "2026-07-03T14:00:00Z",
  "chunks": 120,
  "whisper": { "model": "ggml-medium.bin", "wallMs": 300000 },
  "parakeet": { "model": "parakeet-tdt-0.6b-v3-coreml", "wallMs": 45000 },
  "notes": "compare transcript.md vs transcript.parakeet.md"
}
```

### 2.6 Config additions (`src/types.ts` `DEFAULT_CONFIG`)

| Key | Default | Purpose |
|-----|---------|---------|
| `diarizationEnabled` | `true` | F1 master switch (final pass only by design) |
| `diarizationMinOverlap` | `0.3` | below this overlap ratio a sys entry stays "Others" |
| `analysisBin` | `""` | path to AudioAnalysis binary; empty → resolve like `captureBin` to `native/AudioCapture/.build/release/AudioAnalysis` |
| `parakeetComparePass` | `true` | F3 switch — leave `true` during evaluation, flip to `false` (or promote Parakeet) after comparison |

`resolveAnalysisBin(config)` added to `src/storage.ts`, mirroring `resolveWhisperBin`/captureBin resolution.

---

## 3. Feature specs

### F1 — Speaker diarization (final pass only)

**Trigger:** inside `finalizeSession`, only when ALL hold: `config.diarizationEnabled`, session `mode === "full"`, ≥1 sys chunk on disk, AudioAnalysis binary exists, final `entries` contain ≥1 sys entry.

**Flow:**
1. Progress → `{ phase: "diarize" }`; log "Diarization pass...".
2. `concatSysChunks` streams sys WAV data sections into `sys-concat.wav` in the session dir (written `.tmp` → rename, per project convention). ~75 min = ~140 MB, streamed not buffered.
3. `runDiarizer` spawns `AudioAnalysis diarize` (timeout 120s — FluidAudio is 60x realtime on M1, so 75 min ≈ 75 s worst case with margin).
4. `assignSpeakers` maps segments → entries.
5. Delete `sys-concat.wav`.
6. On ANY error/timeout: `warn("Diarization failed: ..., keeping Others labels")`, entries pass through unmodified. `speakers.json` still written with `"ok": false` + error message.

**Speaker labeling:** raw diarizer speaker IDs renumbered by first appearance → "Speaker 1" spoke first. Deterministic given the same audio.

**Known accuracy bound:** FluidAudio DER ≈ 22% on benchmarks — expect occasional misattribution, especially short interjections. The `minOverlap` fallback to "Others" is the mitigation; do not over-tune v1.

### F2 — Talk-time stats

**Depends on:** final entries (always available); diarization segments (optional — degrades to Me/Others split).

**Flow (in finalize, right after F1):**
1. `computeTalkTime` per §2.4.
2. Append `formatTalkTimeSection(stats)` to the markdown assembled by `assembleMarkdown` (new optional param `talkTime?: TalkTimeStats` on `assembleMarkdown`/`rewriteMarkdown` — the section is part of the atomic rewrite, not a second write).
3. Include in `speakers.json`.

**Dashboard (`src/dashboard.ts`):** `MeetingStats` gains `talkTime?: { me: number; others: number; speakerCount: number }`. Collector reads `speakers.json` when present (fall back to parsing the `## Talk Time` section for robustness). Dashboard adds: overall Me-vs-Others talk ratio, per-meeting speaker count. Keep this minimal in v1 — one stat tile + one column.

**Note:** the opencode `INDEX_PROMPT` needs no change — the Talk Time section and Speaker N labels flow into index.md generation automatically and improve the "Participants" inference for free.

### F3 — Parakeet A/B comparison pass

**Trigger:** `config.parakeetComparePass` && AudioAnalysis binary exists && models ensured. Runs after transcript.md is written, while WAVs still exist, still under the global final-pass lock.

**Flow:**
1. Progress → `{ phase: "ab" }`; log "Parakeet A/B pass...".
2. Reuse the final-pass chunk loop shape (`src/final-pass.ts` refactor: extract the per-chunk iteration with silence-gate into a helper `forEachAudibleChunk(session, config, fn)` used by both passes) — same silence gating, same chunk set, so the comparison is apples-to-apples.
3. Per chunk: `AudioAnalysis transcribe --input chunk.wav` (timeout 60s/chunk). Apply **phrasebook only** (skip whisper-specific `HALLUCINATION_PATTERNS` — Parakeet doesn't produce YouTube-subtitle hallucinations; filtering them would mask each model's true behavior, which is the point of the A/B).
4. Build entries with the **same timestamps and speaker labels** as the main transcript (reuse F1 assignments from `speakers.json`).
5. Write `transcript.parakeet.md` (same assembler, header suffixed "— Parakeet A/B") + `ab-report.json` with wall-clock timings of both passes.
6. On ANY error: warn and skip — main transcript already safely written.

**Evaluation workflow (manual, by user):** after a few meetings, read transcript.md vs transcript.parakeet.md side by side, check ab-report.json for the speed delta. Decision paths:
- Parakeet wins → follow-up change: route final pass through AudioAnalysis (new `finalEngine: "whisper" | "parakeet"` config); F3 flag off.
- Whisper wins → set `parakeetComparePass: false`; delete `TranscribeCommand` later or keep for imports.

### `meet setup` / `meet doctor` additions

- `setup`: build check for AudioAnalysis (same as capture binary check), then `AudioAnalysis models --ensure` with a progress note ("downloading diarization + Parakeet CoreML models, one-time, ~1 GB").
- `doctor`: report AudioAnalysis binary presence + models cache status. No audio test needed.

---

## 4. Implementation plan

Ordered so each phase ships independently and is verifiable on a real meeting before the next.

### Phase 1 — Swift AudioAnalysis binary
1. `Package.swift`: add FluidAudio dependency + `AudioAnalysis` executable target.
2. Implement `models`, `diarize`, `transcribe` subcommands (JSON to stdout, errors to stderr + non-zero exit).
3. Verify by hand on a saved meeting's sys WAVs (concat with `sox`/manual for now).
   - **Checkpoint:** `diarize` returns sane segments on a known 2-person meeting; `transcribe` returns Russian text on a known chunk.

### Phase 2 — F1 diarization in finalize
1. `src/types.ts`: `speaker?` field, config keys, progress phases.
2. `src/storage.ts`: `resolveAnalysisBin`.
3. `src/diarization.ts`: concat + runDiarizer + assignSpeakers (+ tests).
4. `src/assembler.ts`: formatEntry speaker rendering; parse regex back-compat (+ tests).
5. `src/finalize.ts`: wire diarize step + speakers.json write + fail-open.
6. Update CLAUDE.md / AGENTS.md module lists.
   - **Checkpoint:** real meeting finalizes with Speaker 1/2 labels; kill the diarizer mid-run → transcript still finalizes with "Others".

### Phase 3 — F2 talk-time
1. `src/talk-time.ts` (+ tests).
2. `assembleMarkdown`/`rewriteMarkdown` optional talkTime param.
3. `speakers.json` talkTime block; dashboard stat (minimal).
   - **Checkpoint:** transcript footer shows plausible percentages summing to 100.

### Phase 4 — F3 Parakeet A/B
1. Refactor `final-pass.ts` chunk loop into shared helper (no behavior change; existing tests must stay green).
2. Parakeet pass in finalize + `transcript.parakeet.md` + `ab-report.json`.
3. `setup`/`doctor` additions.
   - **Checkpoint:** one real meeting produces both transcripts + report; timings recorded.

### Phase 5 — Evaluation (user)
- Run 3–5 real meetings, compare, decide per §F3. Follow-up change is a separate small spec/commit.

---

## 5. Testing

Node tests (existing `node:test` conventions, mocks for the Swift binary — tests never spawn it):

- `diarization.test.ts`: offset map math (normal / missing chunk index / short last chunk); assignSpeakers (clean overlap, split overlap, below-threshold → undefined, renumbering by first appearance).
- `talk-time.test.ts`: with/without diarization, zero-speech edge, rounding, percent sum.
- `assembler.test.ts` additions: Speaker N render + parse round-trip; legacy "Others" transcripts still parse.
- `finalize.test.ts` additions: diarize step fail-open (binary missing → entries unchanged, warning present, `speakers.json` written with ok:false).

Swift: no automated tests in v1 (matches current package); manual checkpoints per phase + `doctor` visibility.

## 6. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| FluidAudio API drift vs this spec's method names | Phase 1 rework | Verify against repo `Documentation/API.md` first; contract with Node is ours (JSON CLI) so churn is contained in Swift |
| Diarizer accuracy on chunked/gapped concat audio | Wrong labels | Silence-gated chunks are still included in concat (offsets truthful); minOverlap fallback to "Others"; v1 accepts DER ~22% |
| First-run model download (~1 GB) fails offline mid-finalize | F1/F3 skipped | `setup` pre-downloads; finalize fail-open + warning |
| Parakeet ru quality unknown | Wasted pass time | That's the experiment; pass is additive and flag-gated |
| 16 GB RAM pressure during finalize | System sluggish | Passes are sequential (whisper → diarize → parakeet), never concurrent; global final-pass lock held throughout; ANE models have small RAM footprint |
| Pyannote-derived model license CC-BY-4.0 | Attribution needed if project distributed | Add attribution note to README when shipping |

## 7. Open questions (non-blocking, defaults chosen)

1. Should live transcript show "Others" and only the final one get Speaker N? **Yes (chosen)** — diarization is final-pass only by requirement.
2. Should the Parakeet pass also produce its own diarization-independent talk-time? **No** — labels/stats are reused from the main pass; A/B compares ASR text only.
3. Speaker naming ("Speaker 1" → "Anna") — deferred; `speakers.json` versioned format is the hook for it.
