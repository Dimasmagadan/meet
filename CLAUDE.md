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
| **Build Swift** | `cd native/AudioCapture && swift build -c release && cd ../..` |

## Architecture Overview

**meet** is a hybrid TypeScript + Swift application for local meeting transcription on macOS Apple Silicon.

### High-Level Flow

```
meet start "Title"
│
├─ Spawns Swift binary (native/AudioCapture)
│  ├─ Mic capture via AVAudioEngine + VoiceProcessing IO
│  ├─ System audio via ScreenCaptureKit
│  └─ Writes atomic WAV chunks: mic-001.wav, sys-001.wav, ...
│
├─ Node.js pipeline (TypeScript/chokidar)
│  ├─ Watches for new .wav files
│  ├─ Queues whisper-cli transcription (sequential)
│  ├─ Appends to transcript.md incrementally
│  └─ Maintains session state in /tmp/meet-{id}/session.json
│
└─ Finalization
   ├─ Re-transcribes with higher-quality model
   ├─ Filters echoes and duplicates
   ├─ Applies silence gating and phrasebook
   └─ Rewrites transcript.md with sorted entries
```

### Module Breakdown

**src/main.ts** — CLI entry point, dispatches to other commands

**src/cli.ts** — Commander.js command definitions
- `start` — begin recording
- `transcribe` — batch file transcription
- `setup` — dependency/permission verification
- `doctor` — 12-second audio health check
- `list` / `status` / `finalize` — session management

**src/pipeline.ts** — Core event loop
- Watches WAV files with chokidar
- Maintains sequential whisper-cli queue
- Deduplicates chunks
- Persists session state (durable if process crashes)

**src/transcriber.ts** — whisper-cli wrapper
- `transcribeChunk()` — runs whisper-cli on a single WAV
- `cleanText()` — filters noise tokens and hallucinations

**src/assembler.ts** — Transcript assembly
- `appendEntry()` — incremental append during recording
- `rewriteMarkdown()` — final sort and dedup during finalization

**src/import.ts** — File transcription
- `transcribeBatch()` — converts audio/video to WAV via ffmpeg, then transcribes
- Handles batch mode, auto-titling from filename

**src/final-pass.ts** — Post-recording quality improvement
- Re-transcribes all chunks with medium model
- Filters echo/duplicate segments

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
- Hot-reloads ~/.meet/phrasebook.json on each transcription

**src/vad.ts** — Optional voice activity detection (not currently used)

**src/locks.ts** — File-based synchronization
- Prevents concurrent finalization

**native/AudioCapture/** — Swift CLI
- `main.swift` — CLI entry, mode selection (mic/full), signal handling
- `MicCapture.swift` — AVAudioEngine mic tap with VoiceProcessing IO workaround
- `SystemAudioCapture.swift` — ScreenCaptureKit audio-only extraction
- `WAVWriter.swift` — 16kHz mono 16-bit PCM WAV writer, atomic chunk handoff
- `Logger.swift` — Structured JSON logging to stderr

## Key Design Patterns

### File-Based Communication (Swift ↔ Node)

Swift and Node communicate only via the filesystem:
- Swift writes `.wav.tmp`, then atomically renames to `.wav` (finalized chunk)
- Node watches for `.wav` files, transcribes, appends to transcript
- This boundary keeps concerns separated: Swift = audio only, Node = pipeline/output

**Critical**: Always write `.tmp` first, finalize header (if needed), close file, then `rename()` — never write directly to target filename.

### Session State (Durable to Crashes)

Session state lives in `/tmp/meet-{id}/session.json` — written atomically after each chunk is transcribed:
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
- Examples: `audio-metrics.test.ts`, `assembler.test.ts`, `vad.test.ts`

**Test conventions:**
- One test file per module
- No external dependencies (use mocks for file I/O)
- Focus on units, not integration

## Critical Gotchas

### Swift: VoiceProcessing IO 9-Channel Bug

When you call `setVoiceProcessingEnabled(true)` on AVAudioEngine, Apple silently changes the output format to **9 channels**. This is undocumented and breaks most code.

**Solution**: Extract channel 0 manually from the PCM buffer:
```swift
let pcmBuffer = AVAudioPCMBuffer(...)
let floatData = pcmBuffer.floatChannelData![0]  // channel 0 only
```

**Do NOT use AVAudioConverter** — it crashes with 9-channel input. Resample manually with linear interpolation.

### Swift: ScreenCaptureKit Requires Video Config

Even for audio-only capture, you must provide minimal video config:
```swift
config.width = 2
config.height = 2
```

### Swift: WAV Header Finalization

After writing audio data, finalize the WAV header:
```swift
try wavWriter.finalize()  // updates byte counts in header
try FileManager.default.moveItem(atPath: tmpPath, toPath: finalPath)
```

Finalization must happen before the rename — the header includes file size.

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

Key settings:
- `liveModelPath` — model for live transcription during recording (default: `ggml-small.bin`)
- `finalModelPath` — model for final high-quality pass (default: `ggml-medium.bin`)
- `outputDir` — where meetings are saved (default: `~/Meetings`)
- `language` — Whisper language code (default: `ru`)
- `finalRetranscribe` — run final pass after recording (default: `true`)
- `silenceGate` — skip silent chunks (default: `true`)

**Tags**: Define tags in `tags.md` at project root (used by interactive picker)

**Phrasebook**: Custom replacements in `~/.meet/phrasebook.json`
```json
{
  "replacements": [
    { "from": "API", "to": "API", "caseInsensitive": true }
  ]
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

## Common Workflows

### Adding a New CLI Command

1. Add command handler in `src/cli.ts` using Commander.js
2. Implement logic in a new module (e.g., `src/myfeature.ts`)
3. Add tests in `src/myfeature.test.ts`
4. Update README.md if user-facing
5. Update AGENTS.md if architectural

### Fixing a Transcription Quality Issue

Start in `src/cleanText()` (filter noise tokens) or `src/final-pass.ts` (echo removal). Consider:
- Is it a noise token that should be filtered?
- Is it a duplicate from the final pass that should be deduplicated?
- Is it a phrase that phrasebook should fix?

### Debugging Audio Capture

Run `meet doctor` for a 12-second health check, or check:
- Swift build: `cd native/AudioCapture && swift build -c release`
- Audio permission: System Preferences → Privacy → Screen Recording → Enable Terminal
- whisper-cli: `which whisper-cli` should find Homebrew binary

### Debugging Transcription Queue

Check `src/pipeline.ts` and `src/transcriber.ts`. The queue is sequential — if whisper-cli seems hung:
```bash
ps aux | grep whisper-cli
```

If stuck, the next `SIGINT` drains remaining chunks.

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
| Session state | `/tmp/meet-{id}/session.json` |
| Swift binary | `native/AudioCapture/.build/release/AudioCapture` |
| Compiled TypeScript | `dist/` |
