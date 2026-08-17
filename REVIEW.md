# Project Review

## Scope

Static review of the TypeScript and Swift codebase, setup/distribution path, and transcription pipeline. `npm test` passed: 564 tests. The suite does not cover several process-lifecycle, capture, and installation paths below.

## Critical Findings

1. `src/recorder.ts:212-224,639-652`: Pausing sends `SIGUSR1` through `ChildProcess.kill()`, which sets `.killed`; `stopCapture()` then skips `SIGINT`. AudioCapture can keep running while finalization removes its session. Track actual child exit state instead of `.killed`.

2. `src/finalize.ts:735-817`: Empty or failed final transcription can still mark the session `done` and delete every WAV. Require each audible chunk to have text, confirmed silence, or a retained failure before cleanup.

3. `src/storage.ts:89-106`, `src/cli.ts:279-286`, `src/import.ts:130-165`: Output paths use minute precision plus title, so duplicate starts/imports overwrite transcripts. Atomically reserve output directories and add a suffix on collision.

4. `src/cli.ts:263-286`, `src/locks.ts:25-39`: Active recording acquisition is check-then-write, so concurrent starts can both succeed and later remove each other's lock. Acquire with exclusive create before capture starts and release only when an owner token matches.

5. `native/AudioCapture/Sources/AudioCapture/main.swift:55-58,138-144`: Raw signal handlers access Swift objects and mutable state, which is not async-signal-safe. Handle blocked signals with `DispatchSourceSignal` on a serial control queue.

6. `native/AudioCapture/Sources/AudioCapture/MicCapture.swift:96-185,236-249`, `native/AudioCapture/Sources/AudioCapture/SystemAudioCapture.swift:122-242`: Audio callbacks race stop/restart/pause while directly mutating `wavWriter`; shutdown can finalize a WAV during an append. Serialize capture state and move filesystem work off the real-time callback path.

7. `native/AudioCapture/Sources/AudioCapture/main.swift:63-99`: Full mode continues after mic or system capture failure, potentially recording one stream or no streams. Fail startup unless degraded operation is explicitly requested and visibly reported.

8. `src/dashboard.ts:210-220,321-326,351-354`: Meeting titles, tags, and repository names are inserted into HTML and inline JavaScript without escaping. A crafted local title/tag can produce stored XSS in `dashboard.html`. HTML-escape all text, serialize script data safely (including `</script>`), and replace inline handlers with listeners using data attributes.

9. `src/cli.ts:430-436`: Configurable `analysisBin` is interpolated into `execSync`, permitting shell injection through command substitution. Use `execFileSync(analysisBin, ["models", "--ensure"], ...)`.

10. `src/transcriber.ts:220-231`: When Whisper exits successfully but its output file is missing/unreadable, the chunk is recorded as successful empty text. Reject the I/O failure so the chunk remains recoverable and is surfaced at finalization.

## High Findings

1. `src/transcriber.ts:236-239`, `src/final-pass.ts:53-56`: TypeScript chunk matchers accept exactly three digits. Swift emits `mic-1000.wav`/`sys-1000.wav`, so recordings longer than about 4h10m at 15-second chunks stop reaching live and final transcription. Accept one or more digits and centralize chunk keys/filenames.

2. `src/finalize.ts:679-702`: Any non-empty `entries.jsonl` disables markdown recovery, even if JSONL is incomplete. Always merge JSONL, markdown, pipeline results, and known chunk keys with explicit precedence.

3. `src/pipeline.ts:93-154`: `stop()` rescans while the active chunk has left the queue but is not done, so it can transcribe the same chunk twice. Track an in-flight key and recheck state on dequeue.

4. `src/filters.ts:154-157`: Every mic transcript with three or fewer tokens is dropped when same-index system text exists, even when distinct. Remove this unconditional deletion; drop short text only with acknowledgement or echo evidence.

5. `src/finalize.ts:577-585`, `src/parakeet-pass.ts:85-92`: Parakeet A/B speaker assignments are keyed only by chunk index. Mic diarization labels can be assigned to same-index system entries. Key assignments by source and chunk index.

6. `src/storage.ts:36-44`: Malformed `~/.meet/config.json` throws during chunk processing; unbounded/invalid values silently degrade VAD, filtering, and diarization. Validate and clamp config once, retain the last known-valid hot-reloaded config, and report actionable errors.

7. `src/phrasebook.ts:65-87`: User-provided regex runs synchronously in the sequential live path. The source-length cap does not prevent catastrophic backtracking, so one rule can stall transcription indefinitely. Disable raw regex by default or validate it with a safe-regex engine and run replacements with a timeout boundary.

8. `src/transcriber.ts:18-61`: Hallucination filters remove legitimate sentences containing words such as `лайк`, `комментарий`, or `подписка`. Restrict matching to recognizable boilerplate phrases, make aggressive filtering opt-in, and add preservation fixtures.

9. `src/cli.ts:192-207`, `src/import.ts:208-213`: Single-file imports index with opencode by default. The transcript is passed to the user's configured opencode provider, which may be remote. Make indexing explicit opt-in and disclose the selected provider before reading the transcript.

## Installation And Distribution

1. `package.json:2`: The unscoped npm package name `meet` is already published by an unrelated package (`npm view meet version` returns `2.0.0`). Use a scoped package for developer distribution or do not use npm as the user-facing installer.

2. `package.json:24-33`: The npm package does not bundle/build the native capture binaries needed by the CLI. A published package would not work as installed. Prefer signed release artifacts; if npm remains, use a strict `files` allowlist and an explicit native-binary strategy.

3. `README.md:55-83`, `docs/quickstart.md:30-40`: Quick Start initially uses `node dist/main.js` but then documents the uninstalled `meet` command. Define one canonical user installation path; reserve Node commands for contributor documentation.

4. `scripts/setup.sh:47-63`: The script resolves AudioCapture from the caller's working directory, does not build it, and still prints success when it is absent. Resolve the repository from the script location, build all required products, and exit nonzero until the selected profile is usable.

5. `src/cli.ts:430-442`: `meet setup` unexpectedly downloads about 1 GB of optional AudioAnalysis models. Make `setup`/`doctor` read-only and provide an explicit installation command with core/enhanced profiles, download size, disk requirements, and consent.

6. `native/AudioCapture/Sources/AudioCapture/main.swift:80-98`, `README.md:440`: System capture requires macOS 14.2+ and System Audio Recording Only permission, but onboarding says only Apple Silicon and still references Screen Recording. Add a full-mode preflight and correct README and both documentation locales.

## Test Gaps

- No SwiftPM test target exists for AudioCapture or MenuBar.
- `finalizeSession()` lacks end-to-end failure-preservation tests.
- No concurrent active-lock, output-collision, four-digit-chunk, or process-signal lifecycle tests.
- No dashboard escaping, shell-metacharacter, or opencode privacy-policy tests.
- No captured diarizer/Parakeet integration test for source-aware speaker assignment.
- No regression fixtures for short but meaningful utterances, safe hallucination filtering, malformed Whisper output, or final-pass fallback.

## Recommended Order

1. Fix capture shutdown/state ownership, finalization preservation, output collisions, lock ownership, and shell/HTML injection.
2. Make required capture stream failures fatal; serialize native capture writer state; add process-level tests.
3. Repair chunk parsing, pipeline in-flight handling, recovery merging, and source-aware Parakeet labels.
4. Stop silent transcript loss and destructive filtering; add quality/audit sidecars for skipped chunks and filter decisions.
5. Ship a supported installation path: signed arm64 app/CLI artifacts plus Homebrew cask, with `core` and `enhanced` model profiles.
