# meet

Local meeting transcription for macOS (Apple Silicon). Records mic + system audio, transcribes locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), outputs timestamped markdown. No cloud services, no API keys, no data leaving your machine.

**Status: MVP functional, in testing.**

## Features

- **Dual-channel capture** — mic (you) and system audio (others) recorded simultaneously
- **Local transcription** — whisper.cpp with Metal GPU acceleration, no internet required
- **Speaker diarization** — system audio labeled "Speaker 1", "Speaker 2", ... on the final pass (falls back to "Others" if diarization is off/unavailable); mic is always "Me"
- **Speaker rename** — `meet rename` swaps a diarized label for a real name across a finished meeting's output
- **Talk-time stats** — per-speaker duration/percentage footer on every finalized transcript
- **Live transcription** — chunks processed during recording, transcript written incrementally
- **Final retranscription pass** — higher-quality model reprocesses all audio after recording stops
- **Parakeet A/B pass** (optional) — re-transcribes with Parakeet-TDT alongside whisper for manual quality comparison
- **Custom vocabulary** — hot-reloadable `vocabulary.json` biases whisper toward rare names/jargon
- **File import** — transcribe existing audio/video files (m4a, mp3, mp4, wav, etc.)
- **Interactive tag picker** — tag meetings for organization after recording
- **Auto-stop** — configurable max duration and no-speech timeout
- **Attention alerts** — macOS notification + terminal recap when someone says your name during a call
- **Live extractive summary** — rolling `summary.md` next to `transcript.md`, resource-aware (pauses under load)
- **Meeting index** (optional) — Summary/Decisions/Action Items via opencode, for both imports and live recordings
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
meet rename <dir> <id> <name>   Rename a diarized speaker label in a finalized meeting
```

### `start` options

| Option | Description | Default |
|--------|-------------|---------|
| `--mic` | Mic-only mode (no system audio) | off |
| `--silence <sec>` | Audio capture silence timeout (0 = disabled) | 0 |
| `--max-duration <min>` | Auto-stop after N minutes | 60 |
| `--no-text-timeout <min>` | Auto-stop after N processed minutes without transcript | 10 |
| `--voice-processing` | Enable VoiceProcessing IO echo cancellation | off |
| `--no-summary` | Disable live extractive summary draft during recording | off |

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
│   ├── transcript.parakeet.md  # optional Parakeet A/B pass
│   ├── ab-report.json          # optional, alongside transcript.parakeet.md
│   ├── speakers.json           # diarization segments + speakerNames (renamed labels)
│   ├── index.md                # optional, opencodeIndexPass or meet transcribe
│   ├── summary.md              # live draft, generated during recording
│   └── meta.md
└── 2026-05-14_10-00-client-call/
    ├── transcript.md
    ├── summary.md
    └── meta.md
```

### Live summary (`summary.md`)

During a recording, `meet` produces a rolling **extractive** summary next to `transcript.md`. It uses a TextRank-based scorer over a sliding window of the most recent transcript entries and writes `summary.md` every ~2 minutes (configurable via `summaryIntervalChunks`). The summary includes:

- **Key points** — top N entries by TextRank score, chronological
- **Candidate action items** — heuristic regex matches (`нужно`, `надо`, `сделаем`, `deadline`, `до пятницы`, etc.)
- **Participants** — derived from audio source (`Me` / `Others`)

The summarizer is **resource-aware**: it polls `sysctl vm.loadavg` and `vm_stat`, pauses when CPU load exceeds `summaryCpuThresholdLoad` (default 6) or free memory drops below `summaryMemThresholdMb` (default 768MB), and resumes automatically when pressure clears. Status line shows `summary: ok`, `summary: waiting`, `summary: paused (cpu X.X/8c)`, or `summary: disabled`.

This is a **low-quality first tier** — explicitly a draft, not polished. A future `meet summary --full` flag (separate spec) will run a post-finalize LLM refine pass. The transcript is never affected by summarizer state.

To disable: `meet start --no-summary "Title"` or `summaryEnabled: false` in `~/.meet/config.json`.

### Transcript format (live recording)

During recording, system audio is labeled "Others" (source-based). On the final pass, `meet` diarizes system audio and renumbers those entries to "Speaker N", adding a Talk Time footer:

```markdown
# Weekly Standup — 13.05.2026 14:30

**[14:30:00] Me:** Let's discuss the quarterly goals...
**[14:30:00] Speaker 1:** Sure, I have all the data...
**[14:30:15] Me:** Great, what are the key metrics?

## Talk Time

- Me: 5m 30s (52%)
- Speaker 1: 5m 5s (48%)
```

If diarization is disabled, fails, or the session is mic-only, entries stay "Others" and Talk Time falls back to chunk-counting.

### Speaker rename

`Speaker N` labels are per-session — rename them to real names once diarization is done and the meeting has been finalized:

```bash
meet rename ~/Meetings/2026-07-23_14-30-standup "Speaker 1" "Женя"
```

This patches every `transcript*.md` (body + Talk Time footer) and `index.md` in the meeting directory, and persists the mapping in `speakers.json` so a second rename re-targets the name you last set, not the stale `Speaker N` id.

### Parakeet A/B pass

When `AudioAnalysis` is built and `parakeetComparePass: true` (default), finalize also re-transcribes the same audio with Parakeet-TDT, writing `transcript.parakeet.md` and `ab-report.json` next to `transcript.md` for manual quality comparison. Reuses the same diarized speaker labels; has no Talk Time footer.

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
| `phrasebookPath` | `./phrasebook.json` | Custom phrase replacements |
| `vocabularyPath` | `./vocabulary.json` | Custom whisper-prompt vocabulary (rare names/terms) |
| `vocabularyReload` | `true` | Hot-reload the vocabulary file on change |
| `diarizationEnabled` | `true` | Speaker diarization on the final pass |
| `diarizationMinOverlap` | `0.3` | Below this chunk-overlap ratio, a sys entry stays "Others" |
| `analysisBin` | resolved like `captureBin` | Path to the `AudioAnalysis` binary |
| `parakeetComparePass` | `true` | Run the Parakeet A/B pass after finalize |
| `opencodeIndexPass` | `false` | Generate `index.md` (Summary/Decisions/Action Items) after `meet start` recordings finalize |
| `attentionAlerts` | `true` | Master switch for live trigger-word alerts |
| `triggersPath` | `./triggers.json` | Trigger word list |
| `triggersReload` | `true` | Hot-reload the triggers file on change |
| `attentionCooldownSeconds` | `60` | Min seconds between alerts |
| `attentionRecapEntries` | `3` | Transcript entries shown in attention recap |
| `attentionSound` | `Glass` | macOS notification sound name |
| `summaryEnabled` | `true` | Master switch for live extractive summary |
| `summaryIntervalChunks` | `8` | Run summarizer every N chunks (~2 min at 15s) |
| `summaryTopN` | `5` | Key points per window |
| `summaryWindowMaxEntries` | `200` | Sliding window ceiling (entries considered) |
| `summaryMinEntries` | `8` | Don't summarize below this many entries |
| `summaryCpuThresholdLoad` | `6` | Pause when 1-min loadavg exceeds this (raw value) |
| `summaryMemThresholdMb` | `768` | Pause below this free memory |
| `summaryCatchupIntervalMs` | `30000` | Retry interval while overloaded |

### Phrasebook

Create `phrasebook.json` in the project root to define custom text replacements applied to transcripts:

```json
{
  "replacements": [
    { "from": "Т9 глюк", "to": "исправленная фраза" },
    { "from": "API", "to": "API", "caseInsensitive": true }
  ]
}
```

### Vocabulary

Create `vocabulary.json` in the project root to bias whisper's decoder toward rare names/jargon it tends to mis-transcribe:

```json
{
  "terms": ["Acme", "Smith", "ScreenCaptureKit"]
}
```

Terms are folded into whisper's `--prompt` (alongside `config.prompt`) for both live and final passes — a soft bias, not a hard dictionary override. Hot-reloads on file change; missing/invalid file disables the feature with no warnings.

### Attention alerts

During a call, `meet` watches the **live** transcription of other participants (system audio only — your own mic speech is never matched) for trigger words. On a match you get a macOS notification and a terminal banner recapping the last few minutes of transcript, so you can catch up if you were distracted.

Create `triggers.json` in the project root:

```json
{
  "triggers": ["Дим", "Dmitr", "Дмитрий"]
}
```

- Matching is a case-insensitive substring check, so short stems (`"Дим"`) also catch inflected forms (`"Диму"`, `"Димой"`).
- Triggers must be written in **post-phrasebook** form — matching happens after phrasebook replacements are applied.
- Alerts are rate-limited by `attentionCooldownSeconds` (default 60s) so a repeated mention doesn't spam notifications.
- Because live transcription runs in 15s chunks through a sequential queue, an alert can lag 15–45s behind the actual speech — the banner shows the speech-time timestamp, not "just now".
- `meet doctor` prints trigger status and fires a test notification. If nothing appears, allow notifications for your terminal app in **System Settings → Notifications**.
- No triggers file, or `attentionAlerts: false` in config, disables the feature entirely with no warnings.

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
    ├── Diarize system audio → Speaker N + Talk Time footer
    ├── Rewrite sorted markdown transcript
    └── Optional: Parakeet A/B pass, opencode index.md
```

## Project Structure

```
src/
├── main.ts              Entry point
├── cli.ts               Commander CLI: start, setup, list, transcribe, doctor, finalize, status, rename
├── types.ts             Shared types: Session, Config, TranscriptEntry, Chunk
├── pipeline.ts          File watcher + whisper queue, dedup, health monitoring
├── transcriber.ts       whisper-cli wrapper, cleanText() noise filter
├── assembler.ts         Incremental append + final rewrite, timestamp formatting
├── storage.ts           Config loading, output paths, atomic writes, stale detection
├── finalize.ts          Background/foreground session finalization
├── final-pass.ts        High-quality retranscription with echo/duplicate filtering
├── diarization.ts       Speaker diarization (final pass) → "Speaker N" labels
├── talk-time.ts         Per-speaker talk-time stats, Talk Time footer
├── parakeet-pass.ts     Optional Parakeet-TDT A/B pass → transcript.parakeet.md
├── speaker-rename.ts    meet rename: patch a diarized label to a real name
├── vocabulary.ts        Hot-reloadable custom whisper vocabulary
├── regex-utils.ts       Shared escapeRegex()
├── import.ts            ffmpeg conversion, whisper JSON parsing, batch transcription
├── tags.ts              Interactive tag picker
├── opencode.ts          opencode integration for index generation and Q&A
├── capture-events.ts    Parse Swift capture process stderr events
├── capture-health.ts    Audio capture health monitoring
├── audio-metrics.ts     WAV RMS/peak analysis for silence gating
├── filters.ts           Post-transcription text filters
├── phrasebook.ts        Regex-based phrase replacement engine
├── triggers.ts          Trigger-word matching for live attention alerts
├── attention.ts         Attention alerts: cooldown, terminal recap, macOS notification
├── summary.ts           Extractive TextRank summary + SummaryScheduler (rolling draft)
├── system-monitor.ts    macOS resource pressure: loadavg, vm_stat, whisper-cli cache
├── vad.ts               Voice activity detection wrapper
├── locks.ts             File-based locks for finalization and recording
├── status.ts            Display active session status
└── *.test.ts            Unit tests (node:test)

native/AudioCapture/
├── Package.swift
├── Sources/AudioCapture/
│   ├── main.swift              CLI entry, mode selection, signal handling
│   ├── MicCapture.swift        AVAudioEngine input tap, VoiceProcessing IO
│   ├── SystemAudioCapture.swift ScreenCaptureKit audio-only capture
│   ├── WAVWriter.swift         16kHz mono 16-bit PCM WAV, atomic rename
│   └── Logger.swift            Structured JSON logging
└── Sources/AudioAnalysis/      Second binary: diarize/transcribe/models (FluidAudio)
```

## Known Limitations

- **macOS Apple Silicon only** — no Intel, no Linux, no Windows
- **Per-session speaker identity** — diarization labels "Speaker N" within one meeting only; no cross-meeting voice fingerprinting, so the same person gets renamed per meeting
- **Diarization is a final-pass feature** — during live recording, system audio is still "Others"; "Speaker N" labels only appear after finalization
- **Foreground recording** — `meet start` blocks the terminal (background mode planned)
- **No `meet stop`** — stop with `q` key or Ctrl-C
- **No `meet recover`** — stale sessions are detected but not auto-recovered
- **Screen Recording permission required** — for system audio capture in full mode

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands, and conventions.

## License

[MIT](LICENSE)
