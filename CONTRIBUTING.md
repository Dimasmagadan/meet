# Contributing to meet

Thanks for your interest. This is a small, opinionated tool — here's how to work with the codebase.

## Development Setup

### Requirements

- macOS on Apple Silicon (arm64)
- Node.js >= 20
- Xcode Command Line Tools
- Homebrew: `brew install whisper-cpp ffmpeg`

### Build

```bash
npm install
npm run build                              # TypeScript → dist/
cd native/AudioCapture && swift build -c release   # Swift binary
```

### Run

```bash
node dist/main.js start "Test Meeting"
```

### Watch mode

```bash
npm run dev    # tsc --watch in a separate terminal
```

## Testing

```bash
npm test
```

Tests use Node.js built-in test runner (`node:test`). Test files live alongside source files as `*.test.ts`.

Run a single test file:

```bash
npm run build && node --test dist/import.test.js
```

## Lint

```bash
npm run lint    # tsc --noEmit
```

This runs TypeScript type checking. There is no separate linter — `tsc --noEmit` catches type errors and unused imports.

## Project Conventions

### Code style

- TypeScript strict mode, ESM modules (`"type": "module"`)
- No comments in code unless explaining a non-obvious gotcha
- No unnecessary wrapper functions — call Node APIs directly
- Error messages: lowercase, no period at end

### Architecture

- **Swift** handles audio capture only (mic + system audio → WAV chunks)
- **TypeScript/Node** handles everything else: CLI, pipeline, transcription, output
- Communication between Swift and Node is file-based: Swift writes `.wav` files, Node watches for them
- Atomic file writes: always write to `.tmp`, then `rename()` over the target

### Audio capture (Swift)

Key constraints documented in `.opencode/skills/swift-audio/SKILL.md`:

- VoiceProcessing IO silently outputs 9 channels — do NOT use AVAudioConverter
- Extract channel 0 manually, resample with linear interpolation
- ScreenCaptureKit requires minimal video config even for audio-only
- Chunk handoff: write `.wav.tmp`, finalize header, `rename()` to `.wav`

### Transcription (TypeScript)

- Binary: `whisper-cli` (from `brew install whisper-cpp`, NOT the Python `whisper` package)
- Sequential queue: one whisper-cli instance at a time
- `cleanText()` in `transcriber.ts` filters noise tokens and hallucination patterns
- Silence gating: chunks below RMS threshold are skipped during finalization

### File naming

- WAV chunks: `mic-001.wav`, `sys-001.wav` (zero-padded 3 digits)
- Session state: `/tmp/meet-{id}/session.json`
- Output: `~/Meetings/YYYY-MM-DD_HH-MM-{slug}/transcript.md`

## Pull Requests

1. Fork the repo
2. Create a feature branch
3. Make changes
4. Run `npm run lint && npm test` — fix any errors
5. Open a PR with a clear description of what and why

### PR conventions

- One logical change per PR
- Include tests for new behavior
- Update `AGENTS.md` if adding new modules or changing architecture
- Update `README.md` if changing CLI interface or user-facing behavior

## Reporting Issues

Include:

- macOS version and hardware (`sw_vers` and `uname -m`)
- Node.js version (`node --version`)
- Steps to reproduce
- Expected vs actual behavior

## Project Structure

```
src/                    TypeScript source
native/AudioCapture/    Swift audio capture CLI
scripts/setup.sh        Dependency setup script
AGENTS.md               Architecture reference for AI agents
PLAN.md                 Project roadmap and specification
opencode.json           opencode configuration
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
