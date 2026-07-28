---
name: dev-workflows
description: Common dev workflows for the meet project — adding a CLI command, fixing a transcription quality issue, debugging audio capture, debugging the transcription queue. Use when the user asks to add a command, chase a transcription bug, or debug capture/queue hangs in this repo.
---

## Adding a New CLI Command

1. Add command handler in `src/cli.ts` using Commander.js
2. Implement logic in a new module (e.g., `src/myfeature.ts`)
3. Add tests in `src/myfeature.test.ts`
4. Update README.md if user-facing
5. Update AGENTS.md if architectural

## Fixing a Transcription Quality Issue

Start in `src/cleanText()` (filter noise tokens) or `src/final-pass.ts` (echo removal). Consider:
- Is it a noise token that should be filtered?
- Is it a duplicate from the final pass that should be deduplicated?
- Is it a phrase that phrasebook should fix?

## Debugging Audio Capture

Run `meet doctor` for a 12-second health check, or check:
- Swift build: `cd native/AudioCapture && swift build -c release`
- Audio permission: System Preferences → Privacy → Screen Recording → Enable Terminal
- whisper-cli: `which whisper-cli` should find Homebrew binary

## Debugging Transcription Queue

Check `src/pipeline.ts` and `src/transcriber.ts`. The queue is sequential — if whisper-cli seems hung:
```bash
ps aux | grep whisper-cli
```

If stuck, the next `SIGINT` drains remaining chunks.
