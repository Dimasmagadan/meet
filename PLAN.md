# meet — Local Meeting Transcription Tool

## Overview

CLI tool for macOS (Apple Silicon) that records meetings, transcribes them locally with AI, and saves transcripts as markdown files.

**Key features:**
- Dual-channel audio capture: mic (you) + system audio (others)
- Foreground recording with live status output and Ctrl-C finalization
- Local transcription via whisper.cpp (chunks processed during/after recording)
- Speaker labeling by source (mic = "Me", system = "Others")
- Russian language support
- Output: timestamped markdown files in `~/Meetings/`

**Tech stack:**
- TypeScript/Node.js — orchestration, CLI, pipeline
- Swift — audio capture (ScreenCaptureKit + AVAudioEngine)
- whisper.cpp (Metal) — local transcription

---

## Specification

### MVP Scope

**In scope:**
- Foreground `meet start "Title"` command
- Mic + system audio capture by default
- Mic-only mode via `meet start --mic "Title"`
- 15-second finalized WAV chunks
- Local Russian transcription with whisper.cpp
- Source-based speaker labels: `Me` for mic, `Others` for system audio
- Clean markdown transcript in `~/Meetings/`
- Graceful Ctrl-C/SIGTERM shutdown
- Best-effort crash safety for finalized chunks and processed transcript data
- Stale session detection with recovery instructions

**Out of scope for MVP:**
- Background recording sessions
- Functional `meet stop` for background processes
- `meet recover` command implementation
- Per-person diarization within system audio
- Live transcript rendering in the terminal
- Cloud transcription or network services

### Functional Requirements

| ID | Requirement |
|---|---|
| FR-001 | `meet start "Title"` starts a foreground recording session and blocks until Ctrl-C/SIGTERM. |
| FR-002 | Full mode records both microphone audio and system audio. |
| FR-003 | `meet start --mic "Title"` records microphone audio only. |
| FR-004 | AudioCapture writes 16kHz mono 16-bit PCM WAV chunks. |
| FR-005 | AudioCapture writes chunks as `*.wav.tmp` first, then atomically renames finalized files to `*.wav`. |
| FR-006 | The Node pipeline only transcribes finalized `*.wav` files and ignores `*.wav.tmp`. |
| FR-007 | The pipeline transcribes each finalized chunk with `whisper-cli` using Russian language mode. |
| FR-008 | The pipeline persists processed chunk state after each successful transcription. |
| FR-009 | Ctrl-C/SIGTERM triggers graceful shutdown: stop capture, rescan chunks, drain transcription queue, assemble final markdown. |
| FR-010 | The final transcript is written to `~/Meetings/YYYY-MM-DD_HH-MM-{title-slug}/transcript.md`. |
| FR-011 | Transcript entries are timestamped from session start time plus chunk offset. |
| FR-012 | Full mode labels mic transcript entries as `Me` and system transcript entries as `Others`. |
| FR-013 | The CLI prints periodic recording/transcription status while the session runs. |
| FR-014 | `meet start` detects stale sessions in `~/.meet/sessions/` with `session.json` and prints recovery instructions. |
| FR-015 | `meet setup` checks required dependencies, model path, permissions, platform, and writable directories. |

### Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-001 | All transcription runs locally; no meeting audio is sent to a remote service. |
| NFR-002 | Target platform is macOS on Apple Silicon. |
| NFR-003 | The app must preserve finalized WAV chunks after terminal close or process termination. |
| NFR-004 | Expected maximum audio loss on hard termination is the currently open `.wav.tmp` chunk, approximately 15 seconds. |
| NFR-005 | The app must avoid partially-written WAV files being consumed by the transcription pipeline. |
| NFR-006 | The app must not use `AVAudioConverter` for VoiceProcessing IO mic buffers because of the 9-channel output issue. |
| NFR-007 | The MVP should prioritize reliable final transcript generation over live transcript display. |
| NFR-008 | Resource use should remain close to the estimate in this plan on an M2 Pro class machine. |

### Acceptance Criteria

| ID | Scenario | Pass Criteria |
|---|---|---|
| AC-001 | Start a full-mode session for at least 45 seconds, then press Ctrl-C. | Final markdown exists and includes transcribed mic/system chunks in timestamp order. |
| AC-002 | Start a mic-only session for at least 30 seconds, then press Ctrl-C. | Final markdown exists and contains mic transcript entries without `Others` entries. |
| AC-003 | Kill the Node process after at least one finalized chunk exists. | Finalized `*.wav` chunks and `session.json` remain in `~/.meet/sessions/meet-{id}/`. |
| AC-004 | Kill the Swift process while Node is running. | Node reports capture failure, processes finalized chunks, and preserves session data. |
| AC-005 | Create `mic-001.wav.tmp` in a session directory. | The pipeline ignores it and does not call `whisper-cli` for that file. |
| AC-006 | Restart `meet start` with an existing stale session in `~/.meet/sessions/`. | CLI prints stale session path and recovery guidance before starting or exits with clear instructions. |
| AC-007 | Run `meet setup` without `whisper-cli` installed. | CLI reports the missing dependency and installation guidance. |
| AC-008 | Run `meet setup` without microphone or Screen Recording permission. | CLI reports the missing permission and where to grant it. |

### Session State Model

`~/.meet/sessions/meet-{id}/session.json`:

```json
{
  "id": "abc123",
  "title": "Weekly Standup",
  "mode": "full",
  "startedAt": "2026-05-12T14:30:00.000Z",
  "chunkDurationSeconds": 15,
  "sessionDir": "~/.meet/sessions/meet-abc123",
  "outputFile": "/Users/name/Meetings/2026-05-12_14-30-weekly-standup/transcript.md",
  "capturePid": 12345,
  "status": "recording",
  "processedChunks": [
    { "source": "mic", "index": 1, "wav": "mic-001.wav", "status": "done" },
    { "source": "sys", "index": 1, "wav": "sys-001.wav", "status": "done" }
  ],
  "lastError": null
}
```

State must be updated atomically: write a temporary JSON file, then rename it over `session.json`.

### Failure Handling

| Failure | Expected behavior |
|---|---|
| Missing `whisper-cli` | `meet setup` and `meet start` fail before recording with install guidance. |
| Missing model file | `meet setup` and `meet start` fail before recording with download guidance. |
| Microphone permission denied | Mic/full mode fails with a clear System Settings instruction. |
| Screen Recording permission denied | Full mode fails with a clear System Settings instruction. |
| Swift capture exits unexpectedly | Node stops accepting new chunks, processes finalized chunks, writes session error state, and preserves files. |
| `whisper-cli` fails for one chunk | Mark chunk as failed in state, continue or retry once, and include failure in final status. |
| Corrupt finalized WAV | Skip with recorded error; do not block finalization forever. |
| Ctrl-C during transcription | Finish current whisper process if reasonable, then drain or preserve recoverable state. |
| Hard process kill | Already finalized WAV chunks and last written `session.json` remain for recovery. |

---

## Architecture

```
meet start "Weekly Standup"
│
├─ Create session: ~/.meet/sessions/meet-{id}/
├─ Write session metadata: ~/.meet/sessions/meet-{id}/session.json
├─ Create output:  ~/Meetings/2026-05-12_14-30-Weekly-Standup/transcript.md
├─ Start Swift AudioCapture
│   ├─ Mic (AVAudioEngine, 16kHz mono, VoiceProcessing IO enabled)
│   │   └─ Every 15s: mic-001.wav.tmp → atomic rename → mic-001.wav
│   └─ System (ScreenCaptureKit, 16kHz mono, excludesCurrentProcess)
│       └─ Every 15s: sys-001.wav.tmp → atomic rename → sys-001.wav
│
├─ Node.js pipeline watches finalized *.wav files in ~/.meet/sessions/meet-{id}/
│   ├─ New mic-NNN.wav → whisper-cli -l ru -m ggml-small.bin → "Me: ..."
│   ├─ New sys-NNN.wav → whisper-cli -l ru -m ggml-small.bin → "Others: ..."
│   ├─ Append each transcript entry to output markdown incrementally
│   ├─ Persist processed chunk state after each successful transcription
│   └─ Print live status while running
│
└─ Ctrl-C / SIGTERM
    ├─ Signal Swift process to stop and flush final chunks best-effort
    ├─ Wait for Swift process exit
    ├─ Rescan session dir for finalized unprocessed WAV files
    ├─ Drain whisper queue to completion
    ├─ Sort/assemble clean final markdown
    ├─ Keep recoverable session data if shutdown is interrupted
    └─ Done: ~/Meetings/2026-05-12_14-30-Weekly-Standup/transcript.md
```

`meet start` is a foreground command for MVP. It remains attached to the terminal until the user presses Ctrl-C. While recording, it prints lightweight status such as:

```text
Recording 04:30 | chunks: mic 18, sys 18 | transcribed: 30 | last: 14:34
```

Crash-safety target: already finalized WAV chunks and already written transcript data must survive Ctrl-C, terminal close, or process termination. The active `.tmp` chunk may be lost if the process is hard-killed before the WAV header is finalized, so the MVP uses shorter chunks (`15s` default) to reduce worst-case loss.

---

## Components

| Component | Tech | Purpose |
|---|---|---|
| Audio Capture | Swift CLI | ScreenCaptureKit (system audio) + AVFoundation (mic). Splits into finalized WAV chunks with atomic handoff. Two streams. |
| Pipeline | TypeScript/Node.js | Watches for finalized chunks, feeds to whisper.cpp sequentially, tracks durable state, assembles transcript |
| Transcription | whisper.cpp binary (Metal) | `ggml-small.bin` model, processes each 15s chunk in a short CPU/GPU burst |
| CLI | TypeScript (commander) | `meet start/stop/status/list/setup` |

---

## File Structure

```
meet/
├── package.json
├── tsconfig.json
├── .gitignore
├── opencode.json           # opencode config: MCPs, permissions, instructions
├── AGENTS.md               # opencode agent instructions (build, architecture, constraints)
├── PLAN.md
├── .opencode/
│   └── skills/
│       └── swift-audio/
│           └── SKILL.md    # Skill: AVAudioEngine + ScreenCaptureKit pitfalls reference
├── src/
│   ├── main.ts              # Entry point, loads config, dispatches commands
│   ├── cli.ts               # commander: start, setup, list; session lifecycle, incremental write
│   ├── types.ts             # Shared types: Session, Chunk, Config, TranscriptEntry
│   ├── pipeline.ts          # File watcher (chokidar) + chunk processing queue, dedup, durable state
│   ├── transcriber.ts       # Calls whisper-cli per chunk, cleanText() noise/hallucination filter
│   ├── assembler.ts         # Incremental appendEntry + final rewriteMarkdown, makeHeader
│   └── storage.ts           # getOutputDir/getOutputPath, loadConfig, atomic writes, stale detection
├── native/
│   └── AudioCapture/
│       ├── Package.swift    # Swift Package, macOS 13+, swift-argument-parser
│       └── Sources/
│           └── AudioCapture/
│               ├── main.swift              # CLI entry, --output-dir, --chunk-duration, --mode
│               ├── SystemAudioCapture.swift # ScreenCaptureKit audio-only capture
│               ├── MicCapture.swift         # AVAudioEngine input tap, VoiceProcessing IO
│               └── WAVWriter.swift          # 16kHz mono 16-bit PCM WAV output
└── scripts/
    └── setup.sh             # brew install whisper-cpp, download model, build Swift
```

---

## Output Format

Each meeting gets its own subdirectory: `~/Meetings/2026-05-12_14-30-Weekly-Standup/transcript.md`

Transcript is written incrementally during recording (append per chunk), then fully rewritten and sorted on shutdown.

```markdown
# Weekly Standup — 12.05.2026 14:30

**[14:30:00] Me:** Привет, давайте обсудим квартальные цели...

**[14:30:00] Others:** Конечно, у меня есть все данные...

**[14:31:00] Me:** Отлично, какие ключевые метрики?
```

---

## CLI Interface

```bash
meet start "Weekly Standup"     # Start foreground recording (system audio + mic)
meet start --mic "Phone call"   # Mic only mode (in-person, phone on speaker)
meet stop                       # Post-MVP; foreground MVP stops with Ctrl-C
meet status                     # Show active session, last chunk processed
meet list                       # List past meetings
meet setup                      # Check dependencies, download model
```

For MVP, `meet start` is the primary command and remains in the foreground. Ctrl-C is the stop/finalize path. `meet stop` can be implemented later if/when background sessions are added.

---

## Build Order

### Step 1: Project scaffolding ✅

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`

**Deps:** `commander`, `chokidar`, `chalk`, `nanoid`

**Command:** `npm install`

### Step 2: Swift AudioCapture skeleton + WAV writer ✅

**Files:** `native/AudioCapture/Package.swift`, `main.swift`, `WAVWriter.swift`

**Requirements:**
- CLI accepts `--output-dir`, `--chunk-duration`, `--mode`
- Default chunk duration for MVP: `15s`
- Writes 16kHz mono 16-bit PCM WAV
- Writes to `*.wav.tmp`, finalizes header, closes file, then atomically renames to `*.wav`
- Never expose partially-written `*.wav` files to the Node watcher

**Build:** `cd native/AudioCapture && swift build -c release`

### Step 3: Mic capture proof ✅

**Files:** `MicCapture.swift`, `WAVWriter.swift`

**AVAudioEngine mic capture pitfalls:**
- `setVoiceProcessingEnabled(true)` for echo cancellation (critical when not using headphones)
- Voice Processing IO silently changes output to **9 channels** (undocumented by Apple)
- Do NOT use AVAudioConverter — it crashes with 9-channel input
- Instead: extract channel 0 manually, resample with linear interpolation
- System audio ducking fix: `inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)`

**Validation:** record mic chunks and verify each finalized WAV is playable and has the expected sample rate/channel/bit depth.

### Step 4: System audio capture proof ✅

**Files:** `SystemAudioCapture.swift`, `WAVWriter.swift`

System audio is required for MVP. Validate ScreenCaptureKit capture before building the full Node pipeline.

ScreenCaptureKit audio-only capture:
```
config.capturesAudio = true
config.excludesCurrentProcessAudio = true   // prevent feedback loops
config.sampleRate = 16_000
config.channelCount = 1
config.width = 2   // minimal video — we only want audio
config.height = 2
```

**Implementation notes:**
- Use `SCStreamOutput` and process audio `CMSampleBuffer` values
- Select display/content via `SCShareableContent` + `SCContentFilter`
- Require/diagnose Screen Recording permission
- Convert `CMSampleBuffer` → PCM → 16-bit WAV manually

**Validation:** play audio through the system, record `sys-NNN.wav`, and verify the file is non-empty, playable, and excludes current-process feedback.

### Step 5: Full dual-stream Swift capture ✅

**Files:** All files under `native/AudioCapture/`

**CLI interface:**
```
AudioCapture --output-dir ~/.meet/sessions/meet-abc123 --chunk-duration 15 --mode full
# Writes finalized chunks: mic-001.wav, sys-001.wav, mic-002.wav, sys-002.wav, ...
# Writes temporary chunks only as: *.wav.tmp
# SIGINT/SIGTERM → flush final chunks best-effort and exit cleanly
```

### Step 6: Install whisper.cpp + verify Russian transcription ✅

**Manual steps:**
- `brew install whisper-cpp`
- Download `ggml-small.bin` (466MB) to `~/.meet/models/`
- Record or generate a small Russian test WAV
- Verify: `whisper-cli -m ~/.meet/models/ggml-small.bin -l ru -f test.wav --no-timestamps`

**File:** `scripts/setup.sh` (not yet created)

### Step 7: Node.js pipeline (core logic) ✅

**transcriber.ts** — Wraps whisper-cli:
```
whisper-cli -m <model> -l ru -f <wav> --no-timestamps -otxt -of <base> --suppress-nst --entropy-thold 1.5 --logprob-thold -0.5 --no-speech-thold 0.6 --no-prints --prompt "..."
```
- Returns `{ chunkIndex, source: "mic"|"sys", text: string }`
- Uses temp `.txt` output file for deterministic text extraction
- `cleanText()` filters noise tokens (`♪`, `♫`, `[music]`) and Russian hallucination patterns
- Empty results after cleaning are skipped entirely

**pipeline.ts** — Watches session temp dir:
- Detects new `mic-NNN.wav` / `sys-NNN.wav` via chokidar
- Ignores `*.wav.tmp`
- Rescans session dir on startup and shutdown for finalized unprocessed chunks
- Sequential processing queue (one whisper instance at a time)
- Deduplication: skip already-processed chunks
- Durable state: update `~/.meet/sessions/meet-{id}/session.json` after each successful transcription
- Emits transcript events

**assembler.ts** — Merges into markdown:
- Timestamps: chunk index × chunk duration offset + session start time
- Interleaves "Me" and "Others" by timestamp
- Incremental: `appendEntry()` writes each chunk during recording
- Final: `rewriteMarkdown()` sorts and rewrites on graceful exit

**storage.ts** — File management:
- `~/Meetings/` directory
- Each meeting in subdirectory: `YYYY-MM-DD_HH-MM-{title-slug}/transcript.md`
- `loadConfig()` reads `~/.meet/config.json` with defaults
- List/read past meetings (subdirectories)

### Step 8: Foreground CLI commands ✅

**cli.ts** — Commander-based commands

**main.ts** — Entry point

**Foreground MVP behavior:**
- `meet start "Title"` blocks until Ctrl-C/SIGTERM
- Start Swift capture as a child process
- Start watcher/transcription queue in the same Node process
- Print periodic status while recording/transcribing
- Trap Ctrl-C/SIGTERM and run graceful shutdown
- Keep session data if shutdown is interrupted

**Graceful shutdown:**
- Signal Swift capture to stop
- Wait for Swift process exit
- Rescan session dir for finalized unprocessed WAV files
- Drain transcription queue to completion
- Sort and assemble final markdown
- Print final output path

**Crash recovery:**
- On `meet start`, detect stale sessions in `~/.meet/sessions/` with `session.json`
- Print recovery instructions and session paths
- Post-MVP command: `meet recover ~/.meet/sessions/meet-{id}` to process finalized WAV chunks not already present in the transcript

### Step 9: Setup, checks, and polish ⏳

- Config file: `~/.meet/config.json` — model path, output dir, chunk duration, language ✅
- Permission checks: verify/diagnose Screen Recording + Microphone on `meet setup` and `meet start` — partial (checks binary/model only)
- Dependency checks: `whisper-cli`, model file, Swift binary, macOS version, Apple Silicon architecture — partial
- Crash recovery: check for stale sessions in `~/.meet/sessions/` and print recovery instructions ✅
- Process management: PID file in session dir ✅
- Future background mode: implement `meet stop` against persisted PID/session state

---

## Test Plan

### Automated Tests

| Area | Tests |
|---|---|
| Filename parsing | Parse `mic-001.wav`, `sys-123.wav`; reject malformed names and `*.wav.tmp`. |
| Timestamping | Convert chunk index + session start + chunk duration into transcript timestamps. |
| Assembler ordering | Sort mic/system chunks by chunk index and source timestamp; produce stable markdown. |
| State persistence | Write `session.json` atomically and reload processed chunk state. |
| Deduplication | Skip chunks already marked processed in `session.json`. |
| Transcriber wrapper | Parse deterministic whisper output or read temp `.txt` output from a fixture. |
| Storage | Generate safe slugs and output paths under `~/Meetings/`. |
| Setup checks | Report missing binary/model/config paths without starting capture. |

### Manual Integration Tests

| ID | Test |
|---|---|
| IT-001 | Build Swift AudioCapture in release mode. |
| IT-002 | Record mic-only chunks and inspect WAV format: 16kHz, mono, 16-bit PCM. |
| IT-003 | Record system-only chunks while playing audio and verify non-empty playable WAVs. |
| IT-004 | Run full mode and verify both `mic-NNN.wav` and `sys-NNN.wav` are finalized via atomic rename. |
| IT-005 | Run a full `meet start` session, press Ctrl-C, and verify final markdown. |
| IT-006 | Kill the process mid-session and verify finalized chunks plus `session.json` remain. |
| IT-007 | Deny permissions and verify user-facing diagnostics. |

---

## Resource Usage Estimate (M2 Pro)

| Component | RAM | CPU |
|---|---|---|
| Swift audio capture | ~20MB | ~1% |
| Node.js pipeline | ~40MB | ~1% |
| whisper-cli (one chunk) | ~200MB | 20-30% burst for 2-3s |
| **Total** | **~260MB peak** | **~30% burst every 15s** |

---

## Key References

- **Scripta** (github.com/thehwang/Scripta) — Proven dual-channel meeting transcription, documented all audio pitfalls
- **whisper.cpp** (github.com/ggml-org/whisper.cpp) — C/C++ Whisper port with Metal backend
- **SwiftCapture** (github.com/GlennWong/SwiftCapture) — ScreenCaptureKit CLI reference (not used directly: outputs MOV only, no audio-only mode)
- **Model:** `ggml-small.bin` — 466MB, multilingual, good Russian quality. Alternative: `ggml-small-q5_1.bin` (181MB, quantized)

---

## Two Modes

| Mode | Command | Streams | Speaker Labels | Use Case |
|---|---|---|---|---|
| Full | `meet start "title"` | system audio + mic | Me / Others | Zoom, Meet, Telemost, Teams |
| Mic-only | `meet start --mic "title"` | mic only | Flat transcript | In-person, phone on speaker |

Speaker labels are source labels, not diarization. `Others` means all remote/system audio combined; the MVP does not identify individual remote speakers.
