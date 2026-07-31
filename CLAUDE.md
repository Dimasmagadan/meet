# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

| Task | Command |
|------|---------|
| **Build** | `npm run build` |
| **Watch** | `npm run dev` (in separate terminal) |
| **Test all** | `npm test` |
| **Test single file** | `npm run build && node --test dist/import.test.js` |
| **Type check** | `npm run lint` |
| **Run app** | `node dist/main.js start "Title"` |
| **Build Swift** | `./native/AudioCapture/scripts/build.sh` |

## Architecture Overview

**meet** is a hybrid TypeScript + Swift application for local meeting transcription on macOS Apple Silicon.

### High-Level Flow

```
meet start "Title"
│
├─ Spawns Swift binary (native/AudioCapture)
│  ├─ Mic capture via AVAudioEngine + VoiceProcessing IO
│  ├─ System audio via Core Audio process tap (macOS 14.2+)
│  └─ Writes atomic WAV chunks: mic-001.wav, sys-001.wav, ...
│
├─ Node.js pipeline (TypeScript/chokidar)
│  ├─ Watches for new .wav files
│  ├─ Queues whisper-cli transcription (sequential)
│  ├─ Appends to transcript.md incrementally
│  ├─ Maintains session state in ~/.meet/sessions/meet-{id}/session.json
│  └─ Checks sys-channel text against ./triggers.json → macOS notification + terminal recap
│
└─ Finalization
   ├─ Re-transcribes with higher-quality model
   ├─ Filters echoes and duplicates
   ├─ Applies silence gating and phrasebook
   ├─ Diarizes system audio (AudioAnalysis diarize) → "Speaker N" labels, speakers.json
   ├─ Computes per-speaker talk-time stats
   ├─ Rewrites transcript.md with sorted entries + Talk Time footer
   └─ Optional Parakeet A/B pass (AudioAnalysis transcribe) → transcript.parakeet.md, ab-report.json
```

### Module Breakdown

**src/main.ts** — CLI entry point, dispatches to other commands

**src/cli.ts** — Commander.js command definitions
- `start` — begin recording
- `transcribe` — batch file transcription
- `setup` — dependency/permission verification
- `doctor` — 12-second audio health check
- `list` / `status` / `finalize` — session management
- `rename <meetingDir> <speakerId> <newName>` — patch a diarized `Speaker N` label to a real name across a finalized meeting's output (see `src/speaker-rename.ts`)

**src/pipeline.ts** — Core event loop
- Watches WAV files with chokidar
- Maintains sequential whisper-cli queue
- Deduplicates chunks
- Persists session state (durable if process crashes)

**src/transcriber.ts** — whisper-cli wrapper
- `transcribeChunk()` — runs whisper-cli on a single WAV
- `cleanText()` — filters noise tokens and hallucinations

**src/process-priority.ts** — QoS for model spawns (P3)
- `applyQoS(command, args, config)` — wraps whisper-cli / AudioAnalysis spawns as `taskpolicy -c utility <bin> <args>` so the Swift audio capture (default priority) never starves during a live recording
- Sync (both inputs are sync: `config.lowerProcessPriority` + `existsSync('/usr/sbin/taskpolicy')`); fail-opens to no wrapping when taskpolicy is absent
- Applied at the shared `transcribeChunk` spawn (covers live + final), `parakeet-pass.ts`, `diarization.ts`. Complementary to P1's pressure gate — the live path stays un-gated; QoS only yields CPU under contention, never stalls

**src/compute-device.ts** — whisper compute-device probe (P2, doctor-only)
- `detectWhisperCompute(bin)` — runs `whisper-cli --help` once (cached per binary), parses stderr for the backend-init log (`loaded MTL backend`, `GPU name:`) so `meet doctor` can report the active device (e.g. `compute: Metal — Apple M2 Pro`)
- whisper.cpp exposes no positive `--metal` flag (GPU is on by default; only `-ng`/`--no-gpu` and `-dev N` exist), so this reports the device only — there is no flag to emit

**src/assembler.ts** — Transcript assembly
- `appendEntry()` — incremental append during recording
- `rewriteMarkdown()` — final sort and dedup during finalization

**src/import.ts** — File transcription
- `transcribeBatch()` — converts audio/video to WAV via ffmpeg, then transcribes
- Handles batch mode, auto-titling from filename

**src/final-pass.ts** — Post-recording quality improvement
- Re-transcribes all chunks with medium model
- Filters echo/duplicate segments
- `forEachAudibleChunk()` — shared chunk-iteration/silence-gating helper, also used by `parakeet-pass.ts`

**src/diarization.ts** — Speaker diarization (final pass only, F1)
- `concatSysChunks()` — streams sys-*.wav chunks into one WAV, returns per-chunk time offsets
- `runDiarizer()` — spawns `AudioAnalysis diarize`, parses JSON segments
- `assignSpeakers()` — majority time-overlap assignment of segments to sys entries; renumbers to "Speaker 1", "Speaker 2", ...

**src/diarization-ab.ts** — Opt-in offline-VBx diarizer A/B pass (S2, `diarizationAbPass`, default `false`)
- `runDiarizationAbPass()` — re-diarizes `sys-concat.wav` via `AudioAnalysis diarize --offline` (FluidAudio `OfflineDiarizerManager`, VBx clustering) while the primary online result is already in hand
- `buildDiarizationAbReport()` — pure comparison: aligns the two pipelines' independent "Speaker N" numberings by time overlap (greedy max-weight matching), then reports speaker counts, overlap-weighted agreement %, local-disagreement ("swap") count, per-speaker talk-time deltas, and embedding cosine similarity per matched speaker
- Writes `diarization-ab-report.json` next to `transcript.md`; never modifies the transcript. Fails open (warns, doesn't block finalize)

**src/talk-time.ts** — Per-speaker talk-time stats (F2)
- `computeTalkTime()` — Me from mic chunk-counting, Speaker N from diarization segment durations (or Others by sys chunk-counting when diarization is unavailable)
- `formatTalkTimeSection()` — renders the `## Talk Time` transcript footer

**src/parakeet-pass.ts** — Parakeet-TDT A/B comparison pass (F3)
- `runParakeetPass()` — re-transcribes the same audible chunk set as the final pass via `AudioAnalysis transcribe`, phrasebook only (no whisper-specific filtering), reusing F1 speaker labels
- Writes `transcript.parakeet.md` + `ab-report.json` for manual quality comparison against `transcript.md`

**src/triggers.ts** — Trigger-word matching (live attention alerts)
- Structural clone of `phrasebook.ts`: `Triggers.load()`, `maybeReload()` (mtime hot-reload), module singleton `getTriggers()`
- `match()` — case-insensitive substring match against `./triggers.json`, first trigger in file order wins, returns a ~40-char snippet around the hit
- Missing/invalid/empty file → identity mode (no match, no warnings), same convention as phrasebook

**src/attention.ts** — Live trigger-word alerts (Recorder-only, see `specs/SPEC_ATTENTION_2026-07-17.md`)
- `AttentionMonitor.check(chunkIndex, text)` — reloads config + triggers per call (same precedent as pipeline's per-chunk `loadConfig()`), gates on `config.attentionAlerts`, then trigger match, then a per-`kind` cooldown (`Map<kind, lastAlertAtMs>` — extension point for a future `"pause"` kind)
- `buildRecap()` / `formatRecap()` — last `attentionRecapEntries` of `entriesFromSession(...)` ending at the trigger chunk, rendered as a terminal banner with the trigger word highlighted; suppressed if any recap entry is `source === "mic"`
- `buildNotificationArgs()` / `sendMacNotification()` — `osascript` via `on run argv` (`execFile`, never a shell) so transcript text is passed as data, never interpolated into AppleScript source
- Wired from `Recorder.initPipeline()`'s transcribe callback, sys-channel only, skipped during shutdown drain/pause

**src/speaker-rename.ts** — Post-finalize speaker rename (`meet rename`)
- `renameSpeaker()` — reads `speakers.json` from a finalized meeting dir (session dir is already deleted by this point), validates the speaker id against `segments`/`entryAssignments`, then patches every `transcript*.md` (body label + Talk Time footer regexes) and `index.md` (Unicode-aware word-boundary replace) in place
- `speakerNames` map in `speakers.json` holds canonical id → current display label, so a second rename re-targets the previously-applied name, not the stale `Speaker N` id
- Uses shared `escapeRegex` from `regex-utils.ts`

**src/vocabulary.ts** — Custom whisper vocabulary (hot-reload)
- Structural clone of `triggers.ts`/`phrasebook.ts`: `Vocabulary.load()`, `maybeReload()`, module singleton `getVocabulary()`
- `toPromptSuffix(basePrompt, maxTotalChars = 200)` — sizes against the **combined** `config.prompt` + suffix (not the suffix alone), appends `. Термины: a, b, c` in file order until the budget is hit
- Wired into `buildWhisperArgs()` in `transcriber.ts` for both live and final passes
- `./vocabulary.json`: `{ "terms": ["Acme", "Smith"] }`, missing/invalid file → identity mode

**src/regex-utils.ts** — Shared `escapeRegex()`, extracted from byte-identical private copies previously in `phrasebook.ts`/`attention.ts`; also used by `speaker-rename.ts`

**src/storage.ts** — Config and file I/O
- `loadConfig()` — reads ~/.meet/config.json
- `getOutputPath()` — ~/Meetings/YYYY-MM-DD_HH-MM-{slug}/
- Atomic writes via `.tmp` → `rename()`

**src/opencode.ts** — Integration with opencode CLI
- Generates index.md, answers Q&A on live transcript

**src/capture-events.ts** — Parses Swift stderr
- JSON events for chunk completion
- Text logs for diagnostics

**src/audio-metrics.ts** — WAV analysis
- RMS/peak calculation for silence gating

**src/phrasebook.ts** — Custom phrase replacement
- Hot-reloads ./phrasebook.json on each transcription

**src/vad.ts** — Optional voice activity detection (not currently used)

**src/locks.ts** — File-based synchronization
- Prevents concurrent finalization

**native/AudioCapture/** — Swift CLI (audio capture)
- `main.swift` — CLI entry, mode selection (mic/full), signal handling
- `MicCapture.swift` — AVAudioEngine mic tap with VoiceProcessing IO workaround
- `SystemAudioCapture.swift` — Core Audio process tap audio extraction (macOS 14.2+; `@available`-gated in `main.swift`, requires only "System Audio Recording Only" TCC, no Screen Recording)
- `WAVWriter.swift` — 16kHz mono 16-bit PCM WAV writer, atomic chunk handoff
- `Logger.swift` — Structured JSON logging to stderr

**native/AudioCapture/Sources/AudioAnalysis/** — Swift CLI (speaker diarization + Parakeet ASR, FluidAudio)
- Second executable target in the same SPM package; separate from `AudioCapture` so the capture binary's size/permissions stay untouched
- `main.swift` — ArgumentParser root with `diarize`, `transcribe`, `models` subcommands
- `DiarizeCommand.swift` — `DiarizerModels`/`DiarizerManager` → JSON segments on stdout; `--offline` flag switches to `OfflineDiarizerManager` (VBx clustering, same on-disk model repo) for the S2 A/B pass — same JSON shape (`speakerDatabase` on `DiarizationResult` is the shared embeddings source for both paths)
- `TranscribeCommand.swift` — `UnifiedAsrManager` (Parakeet-TDT-0.6B) → JSON `{text, durationMs}`
- `ModelsCommand.swift` — `--ensure` downloads/verifies both model sets for `meet setup`
- `WavIO.swift` — reads our own 16kHz mono 16-bit PCM WAVs into Float32 samples
- Node ↔ Swift boundary is process + JSON, same philosophy as `whisper-cli`

## Key Design Patterns

### File-Based Communication (Swift ↔ Node)

Swift and Node communicate only via the filesystem:
- Swift writes `.wav.tmp`, then atomically renames to `.wav` (finalized chunk)
- Node watches for `.wav` files, transcribes, appends to transcript
- This boundary keeps concerns separated: Swift = audio only, Node = pipeline/output

**Critical**: Always write `.tmp` first, finalize header (if needed), close file, then `rename()` — never write directly to target filename.

### Session State (Durable to Crashes)

Session state lives in `~/.meet/sessions/meet-{id}/session.json` — written atomically after each chunk is transcribed:
```json
{
  "id": "abc123",
  "title": "Weekly Standup",
  "startTime": "2026-05-13T14:30:00Z",
  "chunks": [
    { "file": "mic-001.wav", "transcribed": true },
    { "file": "sys-001.wav", "transcribed": true }
  ]
}
```

If the process crashes mid-transcription, the next run detects unfinalized chunks and resumes. If finalization is interrupted, `meet finalize <sessionDir>` can recover.

### Sequential Transcription Queue

Only one `whisper-cli` instance runs at a time. If multiple chunks arrive while one is transcribing, they queue. This prevents resource exhaustion and ensures consistent ordering.

### Atomic Transcript Writes

During recording, `appendEntry()` appends a single line. During finalization, `rewriteMarkdown()` rewrites the entire file with sorted entries — read current content, deduplicate, sort by timestamp, write back via `.tmp` → `rename()`.

## Testing

Tests use Node.js built-in `node:test` framework (no external test runner needed).

**Run all tests:**
```bash
npm test
```

**Run single test file:**
```bash
npm run build && node --test dist/filters.test.js
```

**Test locations:**
- `src/*.test.ts` files alongside their source modules
- Examples: `audio-metrics.test.ts`, `assembler.test.ts`, `vad.test.ts`, `diarization.test.ts`, `talk-time.test.ts`, `triggers.test.ts`, `attention.test.ts`, `vocabulary.test.ts`, `speaker-rename.test.ts`

**Test conventions:**
- One test file per module
- No external dependencies (use mocks for file I/O)
- Focus on units, not integration

## Critical Gotchas

Swift-specific gotchas (VoiceProcessing IO 9-channel bug, ScreenCaptureKit video config, WAV header finalization order) live in `native/AudioCapture/CLAUDE.md`.

### TypeScript: whisper-cli vs whisper

The binary is `whisper-cli` (from `brew install whisper-cpp`), NOT the Python `whisper` package. They have different CLI interfaces.

Correct: `whisper-cli -m ggml-small.bin -l ru -f input.wav ...`

### TypeScript: Atomic Writes

Always use `.tmp` intermediate file:
```typescript
const tmpPath = outputPath + '.tmp';
fs.writeFileSync(tmpPath, content);
fs.renameSync(tmpPath, outputPath);  // atomic on POSIX
```

This prevents partial reads if process crashes mid-write.

## Configuration & Defaults

**Config file**: `~/.meet/config.json` (created on first run)

All config keys and their defaults live in `DEFAULT_CONFIG` in `src/types.ts` — read that for the full list. Non-obvious behavior worth knowing:
- `opencodeIndexPass` (default `false`) — opt-in since it needs the optional `opencode` CLI and adds up to 180s to finalize
- `lowerProcessPriority` (default `true`) — fail-opens to no wrapping when `taskpolicy` is absent
- `liveQueueLagWarnChunks` (default `8`) — visibility only, never drops chunks

**Tags**: Define tags in `tags.md` at project root (used by interactive picker)

**Phrasebook**: Custom replacements in `phrasebook.json` at project root
```json
{
  "replacements": [
    { "from": "API", "to": "API", "caseInsensitive": true }
  ]
}
```

**Triggers**: Attention-alert words in `triggers.json` at project root (matched against post-phrasebook sys-channel text)
```json
{
  "triggers": ["Дим", "Dmitr", "Дмитрий"]
}
```

**Vocabulary**: Custom whisper-prompt terms in `vocabulary.json` at project root (folded into `--prompt` for both live and final passes)
```json
{
  "terms": ["Acme", "Smith", "ScreenCaptureKit"]
}
```

## opencode Compatibility

This project also works with **opencode** (an alternative AI assistant). Claude Code and opencode coexist:

- **CLAUDE.md** (this file) — Claude Code specific
- **opencode.json** — opencode config (permissions, MCP servers)
- **AGENTS.md** — Architecture reference (used by both)
- **PLAN.md** — Spec/roadmap (used by both)

When editing code or architecture:
1. Update CLAUDE.md if the change affects Claude Code's workflow
2. Update AGENTS.md and PLAN.md for significant architecture changes
3. Update opencode.json permissions if adding new CLIs or external access

They share the same codebase and conventions — no special "opencode mode" is needed.

For common dev workflows (adding a CLI command, fixing a transcription quality issue, debugging audio capture or the transcription queue), see the `dev-workflows` skill.

## Performance Notes

- **Live model** (ggml-small.bin, 466MB) — fast, lower quality
- **Final model** (ggml-medium.bin, ~1.5GB) — slower, higher quality
- **Chunk duration** (default 15s) — shorter chunks are faster but less context for accuracy
- **Metal GPU acceleration** — automatic via whisper-cpp, no extra config needed
- **Silence gating** — skips truly silent chunks to save processing time

## Useful Paths

| Item | Path |
|------|------|
| Meeting output | `~/Meetings/` |
| Config | `~/.meet/config.json` |
| Models | `~/.meet/models/` |
| Session state | `~/.meet/sessions/meet-{id}/session.json` |
| Swift binary | `native/AudioCapture/.build/release/AudioCapture` |
| AudioAnalysis binary | `native/AudioCapture/.build/release/AudioAnalysis` |
| FluidAudio model cache | `~/Library/Application Support/FluidAudio/` |
| Compiled TypeScript | `dist/` |
