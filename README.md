# meet

Local meeting transcription for macOS (Apple Silicon). Records mic + system audio, transcribes locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), outputs timestamped markdown. No cloud services, no API keys, no data leaving your machine.

**Status: MVP functional, in testing.**

## Features

- **Menu bar app** — `Meet.app` records without the terminal: click the menu bar icon to start recording instantly (no naming popup — rename later via "Rename Meeting…" or the tag windows), then start/stop/pause/extend from the menu. Optional launch-at-login. Built from `native/MenuBar/`.
- **Dual-channel capture** — mic (you) and system audio (others) recorded simultaneously
- **Local transcription** — whisper.cpp with Metal GPU acceleration, no internet required
- **Speaker diarization** — system audio labeled "Speaker 1", "Speaker 2", ... on the final pass (falls back to "Others" if diarization is off/unavailable); mic is always "Me"
- **Live speaker labels** — with the cross-session registry enabled, each chunk is matched against known voices during recording (~0.3 s on-device per chunk), so named people show up live instead of "Others"
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

- macOS on Apple Silicon (arm64) — macOS 14.2+ for full mode (mic + system audio); mic-only mode works on 14.0+
- [Homebrew](https://brew.sh)
- Xcode Command Line Tools (`xcode-select --install`)

## Quick Start

### 1. Install dependencies

```bash
brew install whisper-cpp ffmpeg
```

### 2. Clone, build, and link the `meet` command

```bash
git clone https://github.com/Dimasmagadan/meet.git
cd meet
npm install
npm run build
./native/AudioCapture/scripts/build.sh
npm link   # puts `meet` on PATH; re-run after pulling changes that touch package.json
```

### 3. Download model and verify setup

```bash
meet setup
# or use the setup script:
bash scripts/setup.sh
```

### 4. Record a meeting

```bash
meet start "Weekly Standup"
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
meet tag <sessionDir> <tags...> Queue tags for a running recording session
meet status                     Show active recording/finalization jobs
meet rename <dir> <id> <name>   Rename a diarized speaker label in a finalized meeting
meet link <dir> <repoPath>      Attach/replace git repo context in a finalized meeting's meta.md
meet bin-path                   Print resolved runner paths as JSON (used by the menu bar app)
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
| `--repo <path>` | Attach git repo context from `<path>` (persisted as a `- Repo:` line in `meta.md`) | cwd |

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
| `--index` | Generate index.md via opencode (sends the full transcript to your configured opencode provider, which may be remote) | off |
| `--date <date>` | Recording date (YYYY-MM-DD) | file mtime |

```bash
meet transcribe recording.m4a --title "Interview with Alex"
meet transcribe *.m4a                       # batch (titles from filenames)
meet transcribe video.mp4 --date 2026-05-20 # custom date
```

## Menu bar app

`native/MenuBar/` builds a Dock-less `Meet.app` that lives in the menu bar and drives `meet` headlessly — no terminal needed. It shells out to `meet start "<title>" --headless` and controls the session with POSIX signals (SIGINT/SIGUSR1/SIGUSR2/SIGWINCH), reusing the entire TS pipeline unchanged.

```bash
npm run build                          # the app needs `meet` on PATH
npm link                               # if not already done in Quick Start — GUI apps have a minimal PATH
sh native/MenuBar/scripts/build-app.sh # swift build → assemble Meet.app → ad-hoc codesign
open native/MenuBar/.build/Meet.app    # NOT the raw binary — LaunchServices must register the bundle
```

- Click the menu bar mic icon → **Start Recording** → recording begins instantly under a default `"meeting"` title, no popup. Rename it anytime via **Rename Meeting…** or the title field in either tag window (**Add Tag…** / Stop) — the last title is remembered for prefilling.
- Mic/Screen TCC prompts are pre-requested from the app before capture starts; granting them lets the spawned `AudioCapture` record.
- **Launch at Login** toggle (via `SMAppService`) so the app survives reboots — foundation for the future scheduler/calendar features.
- **Notch transcript panel** (14"/16" MacBook Pro, M1 Pro+ only) — while recording, hover the physical notch to reveal a scrollable live tail of the transcript; moves away to hide again. See `specs/SPEC_NOTCH_TRANSCRIPT_PANEL_2026-08-03.md`.
- **Auto-Record Calendar Calls** toggle — polls Calendar every 20s and auto-starts recording when a scheduled event with a Zoom/Meet/Teams/Webex/Whereby/Telemost/Jazz/Kontur link begins, no confirmation dialog (menu bar icon + notch panel are the only signals). Auto-stops at the event's scheduled end (+ grace). Non-attendee participant names from the event are folded into the whisper prompt and saved to `speakers.json` so `meet speakers suggest <dir>` can propose name assignments after finalize. See `specs/SPEC_CALENDAR_AUTOSTART_2026-08-04.md`. Participants are **not** notified that the meeting is being recorded — disclose it yourself if your jurisdiction requires it, and note that attendee names are PII that lands in `speakers.json`/the transcript text, local-only but shared if you share the transcript.
- `meet bin-path` prints the resolved `{node, main, meet}` paths the app uses; set `menuBarMeetBin` in config to override the runner.
- Ad-hoc signature: keep the bundle at a stable path (e.g. `cp -R native/MenuBar/.build/Meet.app ~/Applications/Meet.app`) — moving or rebuilding it re-prompts TCC.

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

If the meeting was auto-started from a calendar event (see Menu bar app above), `meet speakers suggest <dir>` prints talk time per speaker, any cross-session registry match, the calendar's attendee list, and a copy-pasteable `meet rename` line for each still-unnamed speaker — it never renames anything on its own.

```bash
meet speakers suggest ~/Meetings/2026-08-05_10-00-weekly-sync
```

### Parakeet A/B pass

When `AudioAnalysis` is built and `parakeetComparePass: true` (default), finalize also re-transcribes the same audio with Parakeet-TDT, writing `transcript.parakeet.md` and `ab-report.json` next to `transcript.md` for manual quality comparison. Reuses the same diarized speaker labels; has no Talk Time footer.

### Diarizer A/B pass

With `diarizationAbPass: true` (default `false`, opt-in), finalize re-diarizes `sys-concat.wav` with FluidAudio's offline VBx pipeline (`OfflineDiarizerManager`) alongside the primary online pipeline, and writes `diarization-ab-report.json` next to `transcript.md`: speaker counts for both pipelines, a label mapping (aligned by time overlap, not by name), an overlap-weighted agreement %, a swap count for local disagreements, per-speaker talk-time deltas, and embedding cosine similarity per matched speaker. It never modifies `transcript.md` — compare the two pipelines manually across a few real meetings before deciding whether to prefer the offline pipeline.

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
| `diarizationAbPass` | `false` | Run an opt-in offline-VBx diarizer A/B pass after the primary diarization, writing `diarization-ab-report.json` |
| `analysisBin` | resolved like `captureBin` | Path to the `AudioAnalysis` binary |
| `parakeetComparePass` | `true` | Run the Parakeet A/B pass after finalize |
| `opencodeIndexPass` | `false` | Generate `index.md` (Summary/Decisions/Action Items) after `meet start` recordings finalize |
| `liveSpeakerLabels` | `true` | Live per-chunk speaker identification (requires `speakerRegistryEnabled`) |
| `liveSpeakerMatchThreshold` | `0.7` | Cosine threshold for live speaker labels (lower than the finalize threshold) |
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
| `menuBarMeetBin` | (empty = auto) | Explicit `meet` runner for the menu bar app; empty → `meet bin-path` auto-resolves |

### Phrasebook

Create `phrasebook.json` in the project root to define custom text replacements applied to transcripts:

```json
{
  "replacements": [
    { "from": "Т9 глюк", "to": "исправленная фраза" },
    { "from": "API", "to": "API", "caseInsensitive": true },
    { "from": "join", "to": "JOIN", "wordBoundary": true },
    {
      "from": "(номер\\s+задачи[^0-9А-Яа-яЁё]{0,8})(\\d{2,})",
      "to": "$1https://example.com/task/$2/",
      "regex": true,
      "caseInsensitive": true
    }
  ]
}
```

Per-rule keys:

| Key | Default | Effect |
|---|---|---|
| `from`, `to` | — | Required. Plain substring find/replace. |
| `caseInsensitive` | `false` | Case-insensitive match. |
| `wordBoundary` | `false` | Literal mode only: wraps the pattern in `\b…\b` so `"join"` doesn't match `"joining"`. |
| `regex` | `false` | Treat `from` as a raw JS regex (no escaping, no word-boundary wrap). `to` supports `$1`–`$9` backrefs. `wordBoundary` is ignored when this is set. |

**`regex: true` hazards — read before enabling.**

- **ReDoS / catastrophic backtracking.** A pattern like `(a+)+b` (6 chars) on a 30-char input can hang Node for **10+ seconds**. `apply()` runs inside the sequential whisper queue during live recording, so a backtracking pattern doesn't slow the pipeline — it **stalls** it, and every subsequent chunk backs up behind it. Node has no regex timeout. There is **no protection beyond a 500-char sanity cap** on the pattern source; structure is what matters, not length. Keep patterns linear (avoid nested quantifiers, overlapping alternation). If you're unsure, test the regex in a plain `node -e` first.
- **Empty-match patterns are rejected at load.** `a*`, `foo|`, `(?:)` match the empty string and would otherwise fire between every character of every chunk (`"bcd"` → `"XbXcXdX"`). Such rules are silently dropped.
- **Invalid regex is silently dropped** (matches the phrasebook's no-warnings-on-bad-config convention). Check `ruleCount` if a rule isn't firing.

Hot-reloads on file change; missing/invalid file disables the feature with no warnings.

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
├── cli.ts               Commander CLI: start, setup, list, transcribe, doctor, finalize, tag, status, rename
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

native/MenuBar/                 Dock-less Meet.app menu-bar UI
├── Sources/MeetMenuBar/
│   ├── main.swift              NSApplication, setActivationPolicy(.accessory)
│   ├── AppDelegate.swift       Status item, menu, silent start + tag-window renames, TCC preflight
│   ├── RecordingController.swift Headless meet spawn + POSIX signal control
│   ├── RunnerResolver.swift    Resolves node + dist/main.js via `meet bin-path`
│   ├── PermissionController.swift Mic/Screen TCC preflight + System Settings deep-link
│   ├── LoginItemController.swift SMAppService launch-at-login wrapper
│   ├── SessionMonitor.swift    Attaches to CLI-started sessions via lock file
│   └── NotchPanelController.swift Hover-revealed live-transcript panel at the notch
├── Info.plist                  LSUIElement + usage strings
└── scripts/build-app.sh        swift build → assemble Meet.app → ad-hoc codesign
```

## Known Limitations

- **macOS Apple Silicon only** — no Intel, no Linux, no Windows
- **Full mode (mic + system audio) requires macOS 14.2+** — the Core Audio process tap it's built on doesn't exist on older macOS; mic-only mode (`--mic`) works on macOS 14.0+
- **Per-session speaker identity** — diarization labels "Speaker N" within one meeting only; no cross-meeting voice fingerprinting, so the same person gets renamed per meeting
- **Diarization is a final-pass feature** — during live recording, system audio is still "Others"; "Speaker N" labels only appear after finalization
- **Foreground recording** — `meet start` blocks the terminal (background mode planned)
- **No `meet stop`** — stop with `q` key or Ctrl-C
- **No `meet recover`** — stale sessions are detected but not auto-recovered
- **"System Audio Recording Only" permission required** — for system audio capture in full mode (System Settings → Privacy & Security → Audio Recording; the Core Audio process tap approach needs only this, not Screen Recording)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands, and conventions.

## License

[MIT](LICENSE)
