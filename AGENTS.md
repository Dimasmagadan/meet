# meet — Local Meeting Transcription Tool

macOS (Apple Silicon) CLI. Records mic + system audio, transcribes locally with whisper.cpp, outputs timestamped markdown.

**Status: pre-scaffolding.** No source code, `package.json`, or build config exists yet. Full spec: `PLAN.md`.

## Scaffolding (Build Order)

Follow the step sequence in `PLAN.md` → "Build Order" section. Steps have dependencies:

1. `package.json` + `tsconfig.json` + `src/types.ts` → `npm install`
2. Swift AudioCapture skeleton → `cd native/AudioCapture && swift build -c release`
3. Mic capture proof (AVAudioEngine) — **see `.opencode/skills/swift-audio/SKILL.md` for pitfalls**
4. System audio proof (ScreenCaptureKit)
5. Full dual-stream Swift CLI
6. Install whisper.cpp: `brew install whisper-cpp` + download `ggml-small.bin` → `~/.meet/models/`
7. Node.js pipeline (`transcriber.ts` → `pipeline.ts` → `assembler.ts` → `storage.ts`)
8. CLI commands (`cli.ts`, `main.ts`)
9. Setup checks, config, crash recovery

## Critical Gotchas

### Swift Audio (non-obvious, will bite you)

- **VoiceProcessing IO 9-channel bug**: `setVoiceProcessingEnabled(true)` silently changes output to 9 channels. Do NOT use `AVAudioConverter` — it crashes. Extract channel 0 manually, resample with linear interpolation.
- **System audio ducking**: set `voiceProcessingOtherAudioDuckingConfiguration` with `enableAdvancedDucking: false, duckingLevel: .min` or system audio gets attenuated.
- **ScreenCaptureKit**: requires minimal video config (`width: 2, height: 2`) even for audio-only. Set `excludesCurrentProcessAudio = true` to prevent feedback loops.
- **Atomic chunk handoff**: write `*.wav.tmp`, finalize header, close, then `rename()` to `*.wav`. Never expose partial files to the Node watcher.

### Transcription

- Binary: `whisper-cli` (from `brew install whisper-cpp`, NOT `whisper`)
- Invocation: `whisper-cli -m ~/.meet/models/ggml-small.bin -l ru -f <wav> --no-timestamps`
- Model: `ggml-small.bin` (466MB). Quantized alternative: `ggml-small-q5_1.bin` (181MB)

## Architecture (Planned)

```
meet start "Title"
├── src/main.ts          — entry, dispatches CLI commands
├── src/cli.ts            — commander: start, status, list, setup
├── src/capture.ts        — spawns Swift AudioCapture as child process
├── src/pipeline.ts       — chokidar watches for finalized *.wav, feeds transcriber
├── src/transcriber.ts    — wraps whisper-cli per chunk
├── src/assembler.ts      — merges mic+sys transcripts → sorted markdown
├── src/storage.ts        — ~/Meetings/ file management
├── src/types.ts          — shared types
└── native/AudioCapture/  — Swift CLI: ScreenCaptureKit + AVAudioEngine → WAV chunks
```

## Key Constraints

- Target: macOS Apple Silicon only
- Russian transcription (`-l ru`)
- WAV format: 16kHz mono 16-bit PCM, chunk duration: **15s** (not 30s)
- MVP: foreground only — `meet start` blocks, Ctrl-C to stop and finalize
- `meet stop` is post-MVP (background sessions not in scope)
- Session state: `/tmp/meet-{id}/session.json` — must be written atomically (write tmp, rename)
- Output: `~/Meetings/YYYY-MM-DD_HH-MM-{slug}.md`
- Config: `~/.meet/config.json`
- Model: `~/.meet/models/ggml-small.bin`

## Conventions

- Chunk naming: `mic-001.wav`, `sys-001.wav` (zero-padded 3 digits)
- Speaker labels by source: mic → "Me", system → "Others" (not diarization)
- Transcription queue: sequential (one whisper-cli instance at a time)
- Graceful shutdown: SIGINT/SIGTERM → stop capture → rescan unprocessed chunks → drain queue → assemble markdown

## Reference

- **Scripta** (github.com/thehwang/Scripta) — dual-channel meeting transcription, documented audio pitfalls
- **whisper.cpp** (github.com/ggml-org/whisper.cpp) — C/C++ Whisper with Metal backend
- Swift audio pitfalls skill: `.opencode/skills/swift-audio/SKILL.md`
