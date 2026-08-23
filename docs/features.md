---
layout: default
title: Features
description: Every feature in meet — dual-channel capture, local whisper.cpp transcription, speaker diarization, live attention alerts, rolling summary, crash safety, and more.
---

# Features

<p class="lead">An exhaustive catalog of what <strong>meet</strong> does today. The CLI is the source of truth in <code>src/cli.ts</code>; this page mirrors it.</p>

<!-- FEATURES:core-recording -->
## Core recording

- **Menu bar app** — `native/MenuBar/` builds a Dock-less `Meet.app` that drives `meet` headlessly from the menu bar: click the icon, enter a title, start/stop/pause/extend without a terminal. Optional launch-at-login; reuses the full pipeline via shell-out + POSIX signals.
- **Notch transcript panel** (14"/16" MacBook Pro, M1 Pro+) — while recording, hover the physical notch to reveal a scrollable live tail of the transcript; hides again when you move away.
- **Calendar auto-start** — enable "Auto-Record Calendar Calls" in the menu bar to auto-start recording the moment a scheduled event with a Zoom/Meet/Teams/Webex/Whereby/Telemost/Jazz/Kontur link begins. No confirmation dialog; declined events, all-day events, and Free/OOO blocks are skipped. Auto-stops at the event's scheduled end (+ grace, trimmed for back-to-back meetings). The idle menu shows the next qualifying event so the feature stays observable.
- **Foreground meeting recording** — `meet start "Title"` records mic + system audio, transcribes chunks live, and blocks the terminal until you stop.
- **Mic-only mode** — `meet start --mic "Title"` for in-person meetings, interviews, or a phone on speaker.
- **Dual-channel capture** — Swift `AudioCapture` records mic (AVAudioEngine + VoiceProcessing IO) and system audio (ScreenCaptureKit) in parallel into atomic 15s WAV chunks; `excludesCurrentProcessAudio` prevents feedback loops.
- **Atomic chunk handoff** — writes `*.wav.tmp`, finalizes the header, then renames to `*.wav`. The pipeline never transcribes a half-written file.
- **VoiceProcessing echo cancellation** — `--voice-processing` (opt-in) for cleaner audio when you're not wearing headphones.
- **Auto-stop** — configurable max duration (`--max-duration`, default 60 min) and no-speech timeout (`--no-text-timeout`, default 10 min).
- **Capture-side silence timeout** — `--silence <sec>` stops the capture after N seconds of silence.
- **In-recording hotkeys** — `q` stop & finalize in background · `s` stop in foreground · `n` finish & start the next meeting · `p` pause/resume · `e` extend cap +15 min · `a` ask opencode. (Cyrillic aliases: `й ы т ф у`.)
<!-- /FEATURES:core-recording -->

<!-- FEATURES:transcription-quality -->
## Transcription quality

- **Local whisper.cpp (Metal)** — every chunk transcribed on-device with `whisper-cli`; GPU on by default, no network.
- **Two-model strategy** — small model (`ggml-small.bin`, 466 MB) live for low latency; medium model (`ggml-medium.bin`, ~1.5 GB) on the final pass.
- **Russian-optimized, configurable** — defaults to `-l ru`; any whisper-supported language via `config.language`.
- **Noise & hallucination filter** — `cleanText()` drops `[music]`, `♪`, subtitle credits, and "thank you for watching"-style artifacts.
- **Tuned whisper flags** — `--suppress-nst --entropy-thold 2.4 --logprob-thold -1.0 --no-speech-thold 0.6`.
- **Custom vocabulary** — hot-reloadable `vocabulary.json` folds rare names/jargon into whisper's `--prompt` (a soft bias, not a hard override).
- **Phrasebook** — hot-reloadable `phrasebook.json` applies regex/text replacements (with `$1`–`$9` backrefs) to all transcript output.
<!-- /FEATURES:transcription-quality -->

<!-- FEATURES:speaker-identification -->
## Speaker identification

- **Source labels** — live, mic is `Me` and system audio is `Others`; no diarization needed.
- **Speaker diarization** — on the final pass, system audio is concatenated and run through FluidAudio's diarizer to relabel entries as `Speaker 1`, `Speaker 2`… by first appearance. Writes `speakers.json`.
- **Speaker rename** — `meet rename <dir> "Speaker 1" "Женя"` patches the label across `transcript*.md`, `index.md`, and `speakers.json` (idempotent).
- **Cross-session speaker registry** (opt-in, biometric) — stores voice embeddings; cosine-matches known voices across meetings so the same person is auto-labeled.
- **Live speaker labels** (needs the registry) — during recording, each transcribed chunk gets a cheap on-device voiceprint (`AudioAnalysis embed`, ~0.3 s on the ANE) matched against the registry: named people appear under their name in the live transcript and notch panel, unnamed known voices as `Speaker N`. Read-only against the registry; the final pass stays authoritative.
- **Talk-time statistics** — per-speaker duration & percentage, rendered as a `## Talk Time` footer on every finalized transcript.
- **Speaker-name suggestions** — `meet speakers suggest <dir>` prints talk time, registry match confidence, and (for calendar-auto-started meetings) the attendee list against still-unnamed speakers, with copy-pasteable `meet rename` lines. Never renames on its own.
<!-- /FEATURES:speaker-identification -->

<!-- FEATURES:ab-comparison -->
## A/B comparison passes

- **Parakeet-TDT pass** (`parakeetComparePass`, default on) — re-transcribes the same chunks with Parakeet-TDT and writes `transcript.parakeet.md` + `ab-report.json` for manual comparison.
- **Diarizer A/B pass** (`diarizationAbPass`, opt-in) — re-diarizes with the offline VBx pipeline and writes `diarization-ab-report.json` (agreement %, swaps, talk-time deltas, embedding cosine). Never touches `transcript.md`.
<!-- /FEATURES:ab-comparison -->

<!-- FEATURES:live-attention -->
## Live attention & summary

- **Trigger-word alerts** — watches live system-audio transcription (never your own mic) for words in `triggers.json` (typically your name) and fires a macOS notification + terminal recap. Rate-limited.
- **Live extractive summary** — a rolling `summary.md` next to `transcript.md`: TextRank key points, candidate action items, and participants. Runs every ~2 min and pauses under CPU/memory pressure.
- **opencode Q&A mid-call** — press `a` to ask a question about the live transcript.
<!-- /FEATURES:live-attention -->

<!-- FEATURES:finalization -->
## Finalization pipeline

- **Final retranscription pass** — all chunks re-transcribed with the medium model, with echo/duplicate filtering.
- **Silence gating** — chunks below an RMS threshold are skipped.
- **Sorted markdown rewrite** — entries interleaved by timestamp, `Me` / `Speaker N`, with the Talk Time footer.
- **Background or foreground finalize** — `meet finalize <dir> --background` returns the terminal; progress via `meet status`.
- **opencode index** (`opencodeIndexPass`, opt-in) — generates `index.md` (Summary / Decisions / Action Items). Fails open.
<!-- /FEATURES:finalization -->

<!-- FEATURES:post-processing -->
## Post-processing

- **Git repo context** — `meet start --repo <path>` (default: cwd) attaches a `- Repo: name @ sha (branch)` line to `meta.md`. `meet link <dir> <repoPath>` re-attaches it later. Pure local, no network.
- **Interactive tag picker** — tag meetings from `tags.md` when recording stops (skipped in `--headless`).
- **Meeting metadata** — every meeting writes `meta.md` (title, date, mode, tags, repo).
- **HTML dashboard** — `meet dashboard` generates a filterable `~/Meetings/dashboard.html` (stats, tags, repo column).
<!-- /FEATURES:post-processing -->

<!-- FEATURES:import-batch -->
## Import & batch

- **File import** — `meet transcribe <files...>` converts m4a/mp4/wav/etc. via ffmpeg and transcribes the whole file for better context.
- **Batch** — `meet transcribe *.m4a` transcribes many files; titles from filenames; auto-tagged `batch-transcription`.
- **Import-side index** — `index.md` (Summary / Decisions / Action Items) for imports; opt in with `--index` (sends the transcript to your configured opencode provider, which may be remote — off by default).
<!-- /FEATURES:import-batch -->

<!-- FEATURES:reliability -->
## Reliability & performance

- **File-based locks** — active-recording, per-session finalizer (`O_EXCL`), and a global final-pass lock that serializes heavy medium-model passes system-wide. All auto-clean stale entries via `isPidAlive`.
- **Atomic writes** — every persistent write is `.tmp` → `rename()`.
- **Append-only transcript log** — `entries.jsonl` is the durable source of truth; live-transcribed text is never lost, even if the final model is missing.
- **Stale-session detection** — `meet start` warns about orphaned sessions and prints the `meet finalize` recovery command.
- **System-pressure gates** — heavy passes back off under load; the **live path stays un-gated** so recording never stalls.
- **Process priority** — whisper-cli + AudioAnalysis spawn under `taskpolicy -c utility` so audio capture keeps priority.
- **Live queue lag visibility** — the status line turns yellow when transcription backs up (~2 min). Visibility only — no chunk dropping.
<!-- /FEATURES:reliability -->

<!-- FEATURES:cli-reference -->
## CLI reference

<div class="table-wrap" markdown="1">

| Command | Description |
|---|---|
| `meet start "Title"` | Record mic + system audio (foreground) |
| `meet start --mic "Title"` | Record mic only |
| `meet transcribe <files...>` | Transcribe audio/video files |
| `meet setup` | Check dependencies and configuration |
| `meet doctor [mic\|full]` | 12-second capture health check + diagnostics |
| `meet list` | List past meetings |
| `meet finalize <sessionDir>` | Finalize a stopped recording (`--background`) |
| `meet tag <sessionDir> <tags...>` | Queue tags for a running recording session |
| `meet status` | Show active recording/finalization jobs |
| `meet rename <dir> <id> <name>` | Rename a diarized speaker label |
| `meet link <dir> <repoPath>` | Attach/replace git repo context |
| `meet speakers list / forget` | Cross-session speaker registry management |
| `meet speakers suggest <dir>` | Suggest speaker names from calendar attendees + registry matches |
| `meet dashboard` | Generate HTML dashboard |
| `meet bin-path` | Print resolved runner paths (used by the menu bar app) |

</div>

### `start` options

<div class="table-wrap" markdown="1">

| Option | Description | Default |
|---|---|---|
| `--mic` | Mic-only mode | off |
| `--silence <sec>` | Capture silence timeout (0 = off) | 0 |
| `--max-duration <min>` | Auto-stop after N minutes | 60 |
| `--no-text-timeout <min>` | Auto-stop after N processed min with no text | 10 |
| `--voice-processing` | Enable VoiceProcessing IO echo cancellation | off |
| `--no-summary` | Disable live extractive summary | off |
| `--repo <path>` | Attach git repo context from `<path>` | cwd |
| `--attendees <names>` | Comma-separated attendee names (from calendar auto-start) | none |

</div>
<!-- /FEATURES:cli-reference -->

<!-- FEATURES:config-reference -->
## Key configuration (`~/.meet/config.json`)

<div class="table-wrap" markdown="1">

| Flag | Default | Category |
|---|---|---|
| `finalRetranscribe` | `true` | Final retranscription pass |
| `silenceGate` | `true` | Silence gating |
| `diarizationEnabled` | `true` | Speaker diarization |
| `diarizationMinOverlap` | `0.3` | Diarization fallback threshold |
| `parakeetComparePass` | `true` | Parakeet A/B pass |
| `diarizationAbPass` | `false` | Diarizer A/B (opt-in) |
| `opencodeIndexPass` | `false` | `index.md` generation (opt-in) |
| `speakerRegistryEnabled` | `false` | Cross-session registry (opt-in, biometric) |
| `liveSpeakerLabels` | `true` | Live per-chunk speaker labels (needs the registry) |
| `liveSpeakerMatchThreshold` | `0.7` | Live label match threshold |
| `attentionAlerts` | `true` | Live trigger-word alerts |
| `summaryEnabled` | `true` | Live extractive summary |
| `gateHeavyPasses` | `true` | System-pressure gates |
| `lowerProcessPriority` | `true` | QoS lowering |
| `menuBarMeetBin` | (empty = auto) | Explicit `meet` runner for the menu bar app; empty → `meet bin-path` auto-resolves |

</div>

Full details live in the [README](https://github.com/Dimasmagadan/meet#readme) and [AGENTS.md](https://github.com/Dimasmagadan/meet/blob/master/AGENTS.md).
<!-- /FEATURES:config-reference -->
