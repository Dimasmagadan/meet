# meet — Local Meeting Transcription Tool

macOS (Apple Silicon) CLI. Records mic + system audio, transcribes locally with whisper.cpp, outputs timestamped markdown.

**Status: MVP functional.** All core components built and compiling. In testing.

## Current Implementation

```
meet start "Title"
├── src/main.ts              — entry, dispatches CLI commands
├── src/cli.ts               — commander: start, setup, list, transcribe, doctor, finalize, status
├── src/types.ts             — shared types: Session, Chunk, Config, TranscriptEntry
├── src/pipeline.ts          — chokidar watches *.wav, sequential whisper queue, dedup, durable state
├── src/transcriber.ts       — wraps whisper-cli per chunk, cleanText() filters noise/hallucinations
├── src/assembler.ts         — incremental appendEntry + final rewriteMarkdown, makeHeader
├── src/import.ts            — ffmpeg conversion, whisper-cli JSON parsing, batch file transcription
├── src/storage.ts           — loadConfig, getOutputDir/getOutputPath, atomic writes, stale detection
├── src/finalize.ts          — background/foreground session finalization with progress tracking
├── src/final-pass.ts        — high-quality retranscription pass, echo/duplicate filtering
├── src/tags.ts              — interactive tag picker with custom tag support
├── src/opencode.ts          — opencode CLI integration for index generation and Q&A
├── src/capture-events.ts    — parse Swift capture stderr events (JSON + text)
├── src/capture-health.ts    — audio capture health monitoring and restart logic
├── src/audio-metrics.ts     — WAV RMS/peak analysis for silence gating
├── src/filters.ts           — post-transcription text filters
├── src/phrasebook.ts        — regex-based phrase replacement engine (hot-reload)
├── src/vad.ts               — voice activity detection wrapper (optional)
├── src/locks.ts             — file-based locks for finalization and active recording
├── src/status.ts            — display active session/finalization status
└── native/AudioCapture/     — Swift CLI: ScreenCaptureKit + AVAudioEngine → WAV chunks
    ├── main.swift              — CLI entry, --output-dir, --chunk-duration, --mode, --silence-timeout
    ├── MicCapture.swift        — AVAudioEngine input tap, VoiceProcessing IO, 9-channel workaround
    ├── SystemAudioCapture.swift — ScreenCaptureKit audio-only capture
    ├── WAVWriter.swift         — 16kHz mono 16-bit PCM WAV output, atomic rename
    └── Logger.swift            — structured JSON logging
```

## Build & Run

```bash
npm install && npm run build                         # TypeScript
cd native/AudioCapture && swift build -c release     # Swift
node dist/main.js start "Meeting Title"              # Run
```

## Key Constraints

- Target: macOS Apple Silicon only
- Russian transcription (`-l ru`), configurable for any language
- WAV format: 16kHz mono 16-bit PCM, chunk duration: 15s
- Foreground recording — `meet start` blocks, q/Ctrl-C to stop
- Auto-stop: max duration (default 60min) and no-text timeout (default 10min)
- Session state: `~/.meet/sessions/meet-{id}/session.json` — written atomically, cleaned up after finalization
- Output: `~/Meetings/YYYY-MM-DD_HH-MM-{slug}/transcript.md`
- Config: `~/.meet/config.json`
- Live model: `~/.meet/models/ggml-small.bin` (466MB)
- Final model: `~/.meet/models/ggml-medium.bin` (optional, for final pass)

## Transcription Quality

whisper-cli flags: `--suppress-nst --entropy-thold 2.4 --logprob-thold -1.0 --no-speech-thold 0.6 --no-prints --prompt "..."`

`cleanText()` in `transcriber.ts` filters:
- Noise tokens: `[music]`, `(applause)`, `♪`, `♫`
- Russian hallucination patterns: subtitle credits, channel intros, "thank you for watching", etc.
- Empty results after cleaning are skipped entirely

Prompt defaults to: `"Разговор на русском языке. Консультация, обсуждение, вопросы и ответы."` (configurable in config)

Phrasebook (`~/.meet/phrasebook.json`) applies custom regex replacements to all transcript output.

## Output Format

### Live Recording

Each meeting gets its own subdirectory: `~/Meetings/2026-05-13_14-30-weekly-standup/transcript.md`

Transcript is written incrementally during recording (append per chunk), then fully rewritten and sorted during finalization.

```markdown
# Weekly Standup — 13.05.2026 14:30

**[14:30:00] Me:** Привет, давайте обсудим квартальные цели...
**[14:30:00] Others:** Конечно, у меня есть все данные...
```

### File Import

`meet transcribe` converts audio/video files to WAV via ffmpeg, transcribes the whole file with whisper-cli (JSON output), and produces the same output structure.

```bash
meet transcribe recording.m4a --title "Interview with Alex"   # single file
meet transcribe *.m4a                                          # batch (titles from filenames)
meet transcribe video.mp4 --no-index --date 2026-05-20         # video, no index, custom date
```

Output format — relative timestamps, no speaker labels:

```markdown
# Recording Title — 20.05.2026 14:30

**[00:00:00]** Привет, давайте обсудим квартальные цели...
**[00:00:15]** Конечно, у меня есть все данные...
```

Key differences from live recording:
- No chunking — feeds whole file to whisper-cli for better context
- Default model: medium (not small) — quality over latency
- Timestamps relative to file start (00:00:00)
- Date defaults to file modification time
- Requires: ffmpeg (brew install ffmpeg)

## Finalization Pipeline

After recording stops:

1. **Live pass** — remaining unprocessed chunks transcribed with small model
2. **Final pass** (optional, `finalRetranscribe: true`) — all chunks re-transcribed with medium model
3. **Echo/duplicate filtering** — removes repeated segments from final pass
4. **Silence gating** — chunks below RMS threshold filtered out
5. **Rewrite** — sorted, deduplicated markdown written to output file

Finalization can run in background (detached process) or foreground.

## Conventions

- Chunk naming: `mic-001.wav`, `sys-001.wav` (zero-padded 3 digits)
- Speaker labels by source: mic → "Me", system → "Others" (not diarization)
- Transcription queue: sequential (one whisper-cli instance at a time)
- Graceful shutdown: SIGINT/SIGTERM/q → stop capture → rescan → drain queue → finalize
- Atomic writes: always `.tmp` → `rename()`
- No comments in code unless explaining a non-obvious gotcha
- Tests: `node:test`, files named `*.test.ts` alongside source

## Critical Gotchas

### Swift Audio

- **VoiceProcessing IO 9-channel bug**: `setVoiceProcessingEnabled(true)` silently changes output to 9 channels. Do NOT use `AVAudioConverter` — it crashes. Extract channel 0 manually, resample with linear interpolation.
- **System audio ducking**: set `voiceProcessingOtherAudioDuckingConfiguration` with `enableAdvancedDucking: false, duckingLevel: .min`
- **ScreenCaptureKit**: requires minimal video config (`width: 2, height: 2`) even for audio-only. Set `excludesCurrentProcessAudio = true`
- **Atomic chunk handoff**: write `*.wav.tmp`, finalize header, close, then `rename()` to `*.wav`

### Transcription

- Binary: `whisper-cli` (from `brew install whisper-cpp`, NOT `whisper`)
- Live invocation: `whisper-cli -m ggml-small.bin -l ru -f <wav> --no-timestamps -otxt -of <base> --suppress-nst ...`
- Import invocation: `whisper-cli -m ggml-medium.bin -l ru -f <wav> -oj -of <base> -sow --max-len 300 ...`
- Models: `ggml-small.bin` (466MB, live), `ggml-medium.bin` (~1.5GB, final pass)

## What's Not Done Yet

- `meet recover` — process stale sessions (detection exists, recovery command doesn't)
- `meet stop` — background sessions not in scope for MVP
- Permission checks in `meet setup` — only checks binary/model/capture binary
- Automated integration tests
- Linux/Windows support

## Reference

- **Scripta** (github.com/thehwang/Scripta) — dual-channel meeting transcription, documented audio pitfalls
- **whisper.cpp** (github.com/ggml-org/whisper.cpp) — C/C++ Whisper with Metal backend
- Swift audio pitfalls skill: `.opencode/skills/swift-audio/SKILL.md`
