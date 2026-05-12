# meet — Local Meeting Transcription Tool

## Overview

CLI tool for macOS (Apple Silicon) that records meetings, transcribes them locally with AI, and saves transcripts as markdown files.

**Key features:**
- Dual-channel audio capture: mic (you) + system audio (others)
- Real-time transcription via whisper.cpp (chunks processed every 30s)
- Speaker labeling by source (mic = "Me", system = "Others")
- Russian language support
- Output: timestamped markdown files in `~/Meetings/`

**Tech stack:**
- TypeScript/Node.js — orchestration, CLI, pipeline
- Swift — audio capture (ScreenCaptureKit + AVAudioEngine)
- whisper.cpp (Metal) — local transcription

---

## Architecture

```
meet start "Weekly Standup"
│
├─ Create session: /tmp/meet-{id}/
├─ Create output:  ~/Meetings/2026-05-12_14-30-Weekly-Standup.md
├─ Start Swift AudioCapture
│   ├─ Mic (AVAudioEngine, 16kHz mono, VoiceProcessing IO enabled)
│   │   └─ Every 30s: /tmp/meet-{id}/mic-001.wav, mic-002.wav, ...
│   └─ System (ScreenCaptureKit, 16kHz mono, excludesCurrentProcess)
│       └─ Every 30s: /tmp/meet-{id}/sys-001.wav, sys-002.wav, ...
│
├─ Node.js pipeline watches /tmp/meet-{id}/
│   ├─ New mic-NNN.wav → whisper-cli -l ru -m ggml-small.bin → "Me: ..."
│   ├─ New sys-NNN.wav → whisper-cli -l ru -m ggml-small.bin → "Others: ..."
│   └─ Append to markdown with timestamps
│
└─ meet stop
    ├─ SIGINT to Swift process (flushes final chunk)
    ├─ Wait for final whisper processing (~5s)
    ├─ Cleanup /tmp files
    └─ Done: ~/Meetings/2026-05-12_14-30-Weekly-Standup.md
```

---

## Components

| Component | Tech | Purpose |
|---|---|---|
| Audio Capture | Swift CLI (~200 LOC) | ScreenCaptureKit (system audio) + AVFoundation (mic). Splits into 30s WAV chunks. Two streams. |
| Pipeline | TypeScript/Node.js | Watches for new chunks, feeds to whisper.cpp sequentially, assembles transcript |
| Transcription | whisper.cpp binary (Metal) | `ggml-small.bin` model, processes each 30s chunk in ~3-5s on M2 Pro |
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
│   ├── cli.ts               # commander: start, stop, status, list, setup
│   ├── types.ts             # Shared types: Session, Chunk, Config
│   ├── capture.ts           # Spawns Swift process, manages lifecycle
│   ├── pipeline.ts          # File watcher (chokidar) + chunk processing queue
│   ├── transcriber.ts       # Calls whisper-cli per chunk, parses output
│   ├── assembler.ts         # Merges mic + system transcripts → markdown
│   └── storage.ts           # ~/Meetings/ file management
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

```markdown
# Weekly Standup — 2026-05-12 14:30

**[14:30] Me:** Привет, давайте обсудим квартальные цели...

**[14:30] Others:** Конечно, у меня есть все данные...

**[14:31] Me:** Отлично, какие ключевые метрики?
```

---

## CLI Interface

```bash
meet start "Weekly Standup"     # Start recording (system audio + mic)
meet start --mic "Phone call"   # Mic only mode (in-person, phone on speaker)
meet stop                       # Stop recording, finalize transcript
meet status                     # Show active session, last chunk processed
meet list                       # List past meetings
meet setup                      # Check dependencies, download model
```

---

## Build Order

### Step 1: Project scaffolding

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`

**Deps:** `commander`, `chokidar`, `chalk`, `nanoid`

**Command:** `npm install`

### Step 2: Install whisper.cpp + verify Russian transcription

**Manual steps:**
- `brew install whisper-cpp`
- Download `ggml-small.bin` (466MB) to `~/.meet/models/`
- Record a test Russian audio file
- Verify: `whisper-cli -m ~/.meet/models/ggml-small.bin -l ru -f test.wav`

**File:** `scripts/setup.sh`

### Step 3: Swift AudioCapture CLI

**Files:** All files under `native/AudioCapture/`

**Key implementation notes (from Scripta research):**

ScreenCaptureKit audio-only capture:
```
config.capturesAudio = true
config.excludesCurrentProcessAudio = true   // prevent feedback loops
config.sampleRate = 16_000
config.channelCount = 1
config.width = 2   // minimal video — we only want audio
config.height = 2
```

AVAudioEngine mic capture pitfalls:
- `setVoiceProcessingEnabled(true)` for echo cancellation (critical when not using headphones)
- Voice Processing IO silently changes output to **9 channels** (undocumented by Apple)
- Do NOT use AVAudioConverter — it crashes with 9-channel input
- Instead: extract channel 0 manually, resample with linear interpolation
- System audio ducking fix: `inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)`

**Build:** `cd native/AudioCapture && swift build -c release`

**CLI interface:**
```
AudioCapture --output-dir /tmp/meet-abc123 --chunk-duration 30 --mode full
# Writes: mic-001.wav, sys-001.wav, mic-002.wav, sys-002.wav, ...
# SIGINT → flush final chunk and exit cleanly
```

### Step 4: Node.js pipeline (core logic)

**transcriber.ts** — Wraps whisper-cli:
```
whisper-cli -m <model> -l ru -f <wav> --no-timestamps
```
- Returns `{ chunkIndex, source: "mic"|"sys", text: string }`

**pipeline.ts** — Watches session temp dir:
- Detects new `mic-NNN.wav` / `sys-NNN.wav` via chokidar
- Sequential processing queue (one whisper instance at a time)
- Deduplication: skip already-processed chunks
- Emits transcript events

**assembler.ts** — Merges into markdown:
- Timestamps: chunk index × 30s offset + session start time
- Interleaves "Me" and "Others" by timestamp
- Appends to file in real-time

**storage.ts** — File management:
- `~/Meetings/` directory
- Filename: `YYYY-MM-DD_HH-MM-{title-slug}.md`
- List/read past meetings

### Step 5: CLI commands

**cli.ts** — Commander-based commands

**main.ts** — Entry point

### Step 6: Polish

- Config file: `~/.meet/config.json` — model path, output dir, chunk duration, language
- Graceful shutdown: SIGINT → stop capture → wait for final chunk → cleanup
- Crash recovery: check for stale sessions in `/tmp/meet-*`
- Permission checks: verify Screen Recording + Microphone on `meet start`
- Process management: PID file in session dir

---

## Resource Usage Estimate (M2 Pro)

| Component | RAM | CPU |
|---|---|---|
| Swift audio capture | ~20MB | ~1% |
| Node.js pipeline | ~40MB | ~1% |
| whisper-cli (one chunk) | ~200MB | 20-30% burst for 2-3s |
| **Total** | **~260MB peak** | **~30% burst every 30s** |

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
