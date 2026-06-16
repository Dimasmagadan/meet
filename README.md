# meet

Local meeting transcription for macOS (Apple Silicon). Records mic + system audio, transcribes locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), outputs timestamped markdown. No cloud services, no API keys, no data leaving your machine.

**Status: MVP functional, in testing.**

## Features

- **Dual-channel capture** — mic (you) and system audio (others) recorded simultaneously
- **Local transcription** — whisper.cpp with Metal GPU acceleration, no internet required
- **Source-based speaker labels** — mic = "Me", system audio = "Others"
- **Live transcription** — chunks processed during recording, transcript written incrementally
- **Final retranscription pass** — higher-quality model reprocesses all audio after recording stops
- **File import** — transcribe existing audio/video files (m4a, mp3, mp4, wav, etc.)
- **Interactive tag picker** — tag meetings for organization after recording
- **Auto-stop** — configurable max duration and no-speech timeout
- **Crash safety** — finalized chunks and transcript survive hard kills
- **Russian language** optimized (configurable for any language)

## Prerequisites

- macOS on Apple Silicon (arm64)
- [Homebrew](https://brew.sh)
- Xcode Command Line Tools (`xcode-select --install`)

## Quick Start

### 1. Install dependencies

```bash
brew install whisper-cpp ffmpeg
```

### 2. Clone and build

```bash
git clone https://github.com/Dimasmagadan/meet.git
cd meet
npm install
npm run build
cd native/AudioCapture && swift build -c release && cd ../..
```

### 3. Download model and verify setup

```bash
node dist/main.js setup
# or use the setup script:
bash scripts/setup.sh
```

### 4. Record a meeting

```bash
node dist/main.js start "Weekly Standup"
```

Speak into your mic. Press `q` or `s` to stop, `p` to pause/resume, `e` to extend the cap by 15 minutes, or `a` to ask opencode.

## CLI Commands

```
meet start "Title"              Record mic + system audio (foreground)
meet start --mic "Title"        Record mic only
meet transcribe <files...>      Transcribe audio/video files
meet setup                      Check dependencies and configuration
meet doctor [mic|full]          Test audio capture (12-second health check)
meet list                       List past meetings
meet finalize <sessionDir>      Finalize a stopped recording session
meet status                     Show active recording/finalization jobs
```

### `start` options

| Option | Description | Default |
|--------|-------------|---------|
| `--mic` | Mic-only mode (no system audio) | off |
| `--silence <sec>` | Audio capture silence timeout (0 = disabled) | 0 |
| `--max-duration <min>` | Auto-stop after N minutes | 60 |
| `--no-text-timeout <min>` | Auto-stop after N processed minutes without transcript | 10 |
| `--voice-processing` | Enable VoiceProcessing IO echo cancellation | off |

### Keyboard controls during recording

| Key | Action |
|-----|--------|
| `q` | Stop recording, finalize in background |
| `s` | Stop recording, finalize in foreground |
| `a` | Ask opencode a question about the live transcript |

### `transcribe` options

| Option | Description | Default |
|--------|-------------|---------|
| `--title <title>` | Meeting title (single file only) | from filename |
| `--model <model>` | Model: `small` or `medium` | `medium` |
| `--no-index` | Skip index.md generation | off |
| `--date <date>` | Recording date (YYYY-MM-DD) | file mtime |

```bash
meet transcribe recording.m4a --title "Interview with Alex"
meet transcribe *.m4a                       # batch (titles from filenames)
meet transcribe video.mp4 --date 2026-05-20 # custom date
```

## Output

Meetings are saved to `~/Meetings/` with timestamped subdirectories:

```
~/Meetings/
├── 2026-05-13_14-30-weekly-standup/
│   ├── transcript.md
│   └── meta.md
└── 2026-05-14_10-00-client-call/
    ├── transcript.md
    └── meta.md
```

### Transcript format (live recording)

```markdown
# Weekly Standup — 13.05.2026 14:30

**[14:30:00] Me:** Let's discuss the quarterly goals...
**[14:30:00] Others:** Sure, I have all the data...
**[14:30:15] Me:** Great, what are the key metrics?
```

### Transcript format (file import)

```markdown
# Interview Recording — 20.05.2026 14:30

**[00:00:00]** Tell me about your experience...
**[00:00:15]** I've been working in this field for...
```

## Configuration

Config file: `~/.meet/config.json` (created on first run with defaults)

| Setting | Default | Description |
|---------|---------|-------------|
| `modelPath` | `~/.meet/models/ggml-small.bin` | Default whisper model |
| `liveModelPath` | `~/.meet/models/ggml-small.bin` | Model for live transcription |
| `finalModelPath` | `~/.meet/models/ggml-medium.bin` | Model for final retranscription pass |
| `outputDir` | `~/Meetings` | Output directory |
| `chunkDurationSeconds` | `15` | Audio chunk duration |
| `language` | `ru` | Whisper language code |
| `prompt` | Russian consultation prompt | Whisper context prompt |
| `finalRetranscribe` | `true` | Run high-quality final pass |
| `silenceGate` | `true` | Skip silent chunks |
| `phrasebookPath` | `~/.meet/phrasebook.json` | Custom phrase replacements |

### Phrasebook

Create `~/.meet/phrasebook.json` to define custom text replacements applied to transcripts:

```json
{
  "replacements": [
    { "from": "Т9 глюк", "to": "исправленная фраза" },
    { "from": "API", "to": "API", "caseInsensitive": true }
  ]
}
```

### Tags

Create a `tags.md` file in the project root to define tags for the interactive tag picker:

```markdown
# Tags

- work
- personal
- project-name
- client-call
```

## Architecture

```
meet start "Meeting Title"
│
├── Swift AudioCapture (ScreenCaptureKit + AVAudioEngine)
│   ├── Mic → mic-001.wav, mic-002.wav, ...
│   └── System → sys-001.wav, sys-002.wav, ...
│   (atomic .wav.tmp → .wav handoff, 15s chunks)
│
├── Node.js Pipeline (chokidar file watcher)
│   ├── Detects finalized .wav files
│   ├── Sequential whisper-cli queue
│   ├── Incremental transcript append
│   └── Durable session state persistence
│
└── Graceful shutdown (Ctrl-C / SIGTERM)
    ├── Stop Swift capture process
    ├── Rescan + drain transcription queue
    ├── Final retranscription pass (medium model)
    ├── Filter silent chunks by audio metrics
    └── Rewrite sorted markdown transcript
```

## Project Structure

```
src/
├── main.ts              Entry point
├── cli.ts               Commander CLI: start, setup, list, transcribe, doctor, finalize, status
├── types.ts             Shared types: Session, Config, TranscriptEntry, Chunk
├── pipeline.ts          File watcher + whisper queue, dedup, health monitoring
├── transcriber.ts       whisper-cli wrapper, cleanText() noise filter
├── assembler.ts         Incremental append + final rewrite, timestamp formatting
├── storage.ts           Config loading, output paths, atomic writes, stale detection
├── finalize.ts          Background/foreground session finalization
├── final-pass.ts        High-quality retranscription with echo/duplicate filtering
├── import.ts            ffmpeg conversion, whisper JSON parsing, batch transcription
├── tags.ts              Interactive tag picker
├── opencode.ts          opencode integration for index generation and Q&A
├── capture-events.ts    Parse Swift capture process stderr events
├── capture-health.ts    Audio capture health monitoring
├── audio-metrics.ts     WAV RMS/peak analysis for silence gating
├── filters.ts           Post-transcription text filters
├── phrasebook.ts        Regex-based phrase replacement engine
├── vad.ts               Voice activity detection wrapper
├── locks.ts             File-based locks for finalization and recording
├── status.ts            Display active session status
└── *.test.ts            Unit tests (node:test)

native/AudioCapture/
├── Package.swift
└── Sources/AudioCapture/
    ├── main.swift              CLI entry, mode selection, signal handling
    ├── MicCapture.swift        AVAudioEngine input tap, VoiceProcessing IO
    ├── SystemAudioCapture.swift ScreenCaptureKit audio-only capture
    ├── WAVWriter.swift         16kHz mono 16-bit PCM WAV, atomic rename
    └── Logger.swift            Structured JSON logging
```

## Known Limitations

- **macOS Apple Silicon only** — no Intel, no Linux, no Windows
- **Source-based speaker labels** — "Me" / "Others" by audio source, not per-person diarization
- **Foreground recording** — `meet start` blocks the terminal (background mode planned)
- **No `meet stop`** — stop with `q` key or Ctrl-C
- **No `meet recover`** — stale sessions are detected but not auto-recovered
- **Screen Recording permission required** — for system audio capture in full mode

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands, and conventions.

## License

[MIT](LICENSE)
