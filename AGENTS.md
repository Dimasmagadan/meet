# meet — Local Meeting Transcription Tool

CLI tool for macOS (Apple Silicon). Records meetings, transcribes locally with whisper.cpp, saves as markdown.

## Build Commands

- TypeScript: `npm run build` (after scaffolding)
- Swift: `cd native/AudioCapture && swift build -c release`
- Lint: `npm run lint`
- Test: `npm test` (once configured)

## Architecture

- `src/` — TypeScript/Node.js CLI + pipeline + orchestration (commander, chokidar)
- `native/AudioCapture/` — Swift CLI (~200 LOC). ScreenCaptureKit (system audio) + AVAudioEngine (mic). Splits into 30s WAV chunks. Spawned as child process.
- whisper.cpp — external binary (`brew install whisper-cpp`), called via `whisper-cli`

## Key Constraints

- Target: macOS Apple Silicon only
- Russian language transcription (`-l ru`)
- 16kHz mono 16-bit PCM WAV chunks, 30s each
- Two audio streams: mic (AVAudioEngine) + system (ScreenCaptureKit)
- VoiceProcessing IO has 9-channel output bug — use manual channel extraction, NOT AVAudioConverter
- Output: timestamped markdown in `~/Meetings/`

## File Conventions

- Temp session files: `/tmp/meet-{id}/`
- Transcripts: `~/Meetings/YYYY-MM-DD_HH-MM-{slug}.md`
- Config: `~/.meet/config.json`
- Model: `~/.meet/models/ggml-small.bin`

## CLI Interface

```
meet start "Title"        # system audio + mic
meet start --mic "Title"  # mic only
meet stop                 # finalize transcript
meet status               # active session info
meet list                 # past meetings
meet setup                # check deps, download model
```

## Dependencies

- `commander` — CLI framework
- `chokidar` — file watcher for chunk detection
- `chalk` — terminal colors
- `nanoid` — session IDs
- whisper-cpp (brew)
- Swift Argument Parser (SPM)

## Reference Projects

- **Scripta** (github.com/thehwang/Scripta) — dual-channel meeting transcription, documented audio pitfalls
- **whisper.cpp** (github.com/ggml-org/whisper.cpp) — C/C++ Whisper with Metal backend
