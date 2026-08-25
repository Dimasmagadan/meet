# meet — Local Meeting Transcription Tool

macOS (Apple Silicon) CLI. Records mic + system audio, transcribes locally with whisper.cpp, outputs timestamped markdown.

**Status: MVP functional.** All core components built and compiling. In testing.

## Current Implementation

```
meet start "Title"
├── src/main.ts              — entry, dispatches CLI commands
├── src/cli.ts               — commander: start, setup, list, transcribe, doctor, finalize, tag, status, rename, link, speakers, dashboard, bin-path, retitle, ask
├── src/recorder.ts          — session orchestration: spawns Swift capture, wires Pipeline, handles stdin hotkeys
├── src/types.ts             — shared types: Session, Chunk, Config, TranscriptEntry
├── src/pipeline.ts          — chokidar watches *.wav, sequential whisper queue, dedup, durable state
├── src/transcriber.ts       — wraps whisper-cli per chunk, cleanText() filters noise/hallucinations
├── src/assembler.ts         — incremental appendEntry + final rewriteMarkdown, makeHeader
├── src/import.ts            — ffmpeg conversion, whisper-cli JSON parsing, batch file transcription
├── src/entries-store.ts     — append-only entries.jsonl for crash-safe transcript persistence
├── src/storage.ts           — loadConfig, getOutputDir/getOutputPath, atomic writes, stale detection
├── src/finalize.ts          — background/foreground session finalization with progress tracking
├── src/final-pass.ts        — high-quality retranscription pass, echo/duplicate filtering
├── src/diarization.ts       — speaker diarization (final pass only): concatSysChunks, runDiarizer (AudioAnalysis diarize), assignSpeakers → "Speaker N" labels; parseDiarizeOutput threads per-speaker embeddings
├── src/speaker-registry.ts  — cross-session speaker registry (S1): cosine match (backend-scoped, threshold 0.75) over multi-centroid voiceprints (up to 3 per person; EMA-adapted on confirmed matches), register/forget/quarantine, matchSpeakerRanked (top-2 + ambiguity guard for the live path), matches.log; opt-in via speakerRegistryEnabled (biometric)
├── src/live-speakers.ts     — live per-chunk speaker identification: `AudioAnalysis embed` (~0.3s ANE/chunk) → read-only registry match → transcript labels during recording ("Name"/"Speaker N"); session-local prints for unknown voices, AMBIGUITY_MARGIN guard, gated by liveSpeakerLabels+speakerRegistryEnabled
├── src/diarization-ab.ts    — opt-in offline-VBx diarizer A/B pass (S2, `diarizationAbPass`): re-diarizes sys-concat.wav via `AudioAnalysis diarize --offline`, aligns the two independent label numberings by time overlap, writes diarization-ab-report.json (speaker counts, agreement %, swaps, talk-time deltas, embedding cosine); never touches transcript.md
├── src/talk-time.ts         — per-speaker talk-time stats, renders the "## Talk Time" transcript footer
├── src/parakeet-pass.ts     — optional Parakeet-TDT A/B pass (AudioAnalysis transcribe) → transcript.parakeet.md, ab-report.json
├── src/speaker-rename.ts    — meet rename: patches a diarized "Speaker N" label to a real name across a finalized meeting's transcript*.md/index.md/speakers.json
├── src/speakers-suggest.ts  — meet speakers suggest (SPEC_CALENDAR_AUTOSTART_2026-08-04 §6.3): read-only formatter over speakers.json — talk time, registry matches/scores, calendarAttendees, copy-pasteable `meet rename` lines per unnamed speaker; never writes anything itself
├── src/git-context.ts       — local-only git repo detect (`detectGitContext`) + `meet link` rewriter; captured at `meet start` (--repo/cwd), persisted as a `- Repo:` line in meta.md
├── src/vocabulary.ts        — hot-reloadable custom whisper vocabulary (./vocabulary.json), folded into --prompt for live and final passes; `toPromptSuffix()` also accepts calendar-attendee `extraTerms`, sized in after file terms
├── src/regex-utils.ts       — shared escapeRegex(), used by phrasebook.ts/attention.ts/speaker-rename.ts
├── src/tags.ts              — interactive tag picker with custom tag support
├── src/opencode.ts          — opencode CLI integration for index generation and Q&A
├── src/capture-events.ts    — parse Swift capture stderr events (JSON + text)
├── src/capture-health.ts    — audio capture health monitoring and restart logic
├── src/audio-metrics.ts     — WAV RMS/peak analysis for silence gating
├── src/filters.ts           — post-transcription text filters
├── src/phrasebook.ts        — regex-based phrase replacement engine (hot-reload)
├── src/triggers.ts          — trigger-word matching for live attention alerts (hot-reload, phrasebook clone)
├── src/attention.ts         — AttentionMonitor: trigger detection, cooldown, terminal recap, macOS notification
├── src/summary.ts           — extractive TextRank summary + SummaryScheduler (rolling summary.md during recording)
├── src/system-monitor.ts    — macOS resource pressure: sysctl loadavg, vm_stat free mem, pgrep whisper-cli/AudioAnalysis cache; `whenNotOverloaded`/`makeDeadline` gate heavy BATCH passes only (P1)
├── src/compute-device.ts    — P2 (doctor-only): `detectWhisperCompute` runs `whisper-cli --help` once (cached), parses stderr for `loaded MTL backend` + GPU name; **no flag emitted** — whisper.cpp has no positive `--metal` (GPU on by default; only `-ng`/`--no-gpu`, `-dev N` exist)
├── src/process-priority.ts  — P3: `applyQoS`/`buildQoSArgs` wrap whisper-cli/AudioAnalysis spawns with `taskpolicy -c utility` so the Swift capture keeps priority; fail-open when taskpolicy is absent
├── src/vad.ts               — voice activity detection wrapper (optional)
├── src/locks.ts             — file-based locks for finalization and active recording
├── src/status.ts            — display active session/finalization status
├── native/AudioCapture/     — Swift CLI: Core Audio process tap + AVAudioEngine → WAV chunks
│   ├── main.swift              — CLI entry, --output-dir, --chunk-duration, --mode, --silence-timeout; guards SystemAudioCapture behind `#available(macOS 14.2, *)`
│   ├── MicCapture.swift        — AVAudioEngine input tap, VoiceProcessing IO, 9-channel workaround
│   ├── SystemAudioCapture.swift — Core Audio process tap (macOS 14.2+, SPEC_TCC_SCREEN_REPROMPT_2026-07-31 §6): `CATapDescription(__monoGlobalTapButExcludeProcesses:)` → private aggregate device (tap + default output subdevice for clock) → `AudioDeviceCreateIOProcIDWithBlock` → manual linear-interpolation resample to 16kHz, same pattern as MicCapture. Needs only "System Audio Recording Only" TCC, not Screen Recording — replaced ScreenCaptureKit, which required full Screen Recording for audio-only capture and was subject to periodic re-approval nags
│   ├── WAVWriter.swift         — 16kHz mono 16-bit PCM WAV output, atomic rename
│   └── Logger.swift            — structured JSON logging
└── native/MenuBar/         — Swift menu-bar .app (SPEC_MENUBAR_UI_2026-07-30): spawns `meet start --headless`, controls via SIGINT/SIGUSR1/SIGUSR2/SIGWINCH; ad-hoc signed, Dock-less, optional launch-at-login
    ├── main.swift              — NSApplication; setActivationPolicy(.accessory) (no Dock icon)
    ├── AppDelegate.swift       — status item + menu (start/pause/stop/extend, Launch-at-Login, Auto-Record Calendar Calls toggle + live "Next: … in Nm" line), silent start (no post-start popup — naming via "Rename Meeting…" or the tag windows' title field), TCC preflight before spawn
    ├── RecordingController.swift — headless meet spawn + POSIX signal control + attach-to-existing-session; `start(title:maxDurationMinutes:attendees:)` — manual Start omits both (CLI defaults apply), calendar auto-start passes both
    ├── RunnerResolver.swift    — shells out to `meet bin-path` (PATH augmented with /opt/homebrew/bin,/usr/local/bin) → cached Runner{node,[main.js]}
    ├── PermissionController.swift — TCC baseline: ensureMic() gated synchronously; no screen/system-audio preflight (SPEC_TCC_SCREEN_REPROMPT_2026-07-31 §6 — Core Audio process taps have no public preflight API; AudioCapture raises the "System Audio Recording Only" prompt itself as the responsible process), openPrivacySettings() deep-link
    ├── LoginItemController.swift — SMAppService.mainApp launch-at-login wrapper (macOS 13+)
    ├── SessionMonitor.swift    — polls active-recording.lock every 5s → attaches to CLI-started sessions
    ├── NotchPanelController.swift — SPEC_NOTCH_TRANSCRIPT_PANEL_2026-08-03 + SPEC_NOTCH_TABS_2026-08-12: single `KeyPanel` (canBecomeKey=true subclass) anchored at physical notch rect, grows on hover to show a scrollable tail of the active recording's transcript.md (polled while revealed); Ask AI mode (`meet ask` marker round trip) forces bigFrame, reuses the text view for the answer, suppresses hover-hide while typing; armed only while recording/paused
    ├── ActiveLock.swift        — shared reader for `~/.meet/sessions/active-recording.lock` JSON; collapsed from hand-rolled copies in NotchPanelController/RecordingController/SessionMonitor
    ├── CalendarAutoStartController.swift — SPEC_CALENDAR_AUTOSTART_2026-08-04: EKEventStore poll (20s Timer, dedicated fetch queue), permission split (Calendar requested at toggle-enable, mic checked synchronously at auto-start — never prompts from a timer callback), sleep/wake + `.EKEventStoreChanged` observers, occurrence-key dedup (per-occurrence, not per-series — the original bug), deterministic overlap resolution (no blocking alert), non-self attendees → `RecordingController.start(attendees:)`
    ├── CalendarMatch.swift     — pure logic behind the controller, no EventKit/AppKit imports so it's directly unit-testable: `hasCallLink()`, `isLive()` (lateness gate), `occurrenceKey()`, `capMinutes()` (back-to-back grace trimming, never 0), `rankCandidates()`; `selfCheck()` run via `MeetMenuBar --self-test-calendar`
    ├── Info.plist              — LSUIElement, NSMicrophoneUsageDescription, bundle id com.dimasmagadan.meet.menubar (NSScreenCaptureDescription dropped — not a real TCC key; Phase 2 adds NSAudioCaptureUsageDescription), NSCalendarsUsageDescription + NSCalendarsFullAccessUsageDescription (macOS 13/14+ split)
    └── scripts/build-app.sh    — swift build → assemble Meet.app → ad-hoc codesign (-s -)
```

## Build & Run

```bash
npm install && npm run build                         # TypeScript
./native/AudioCapture/scripts/build.sh              # Swift
node dist/main.js start "Meeting Title"              # Run
npm run lint                                         # Type-check (tsc --noEmit)
npm run build && node --test dist/import.test.js     # Single test file
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

**Metal (P2):** `detectWhisperCompute` runs `whisper-cli --help` once (cached per binary) and parses its stderr backend-init log so `meet doctor` can report the active device (e.g. `compute: Metal — Apple M2 Pro`). whisper.cpp exposes **no** positive `--metal` flag — GPU is on by default and the only knobs are `-ng`/`--no-gpu` (disable) and `-dev N`/`--device N` (select) — so this is device visibility only; **no flag is ever emitted** and transcription args are unchanged. (`-ngl`/`--ngl` are llama.cpp flags, never whisper.cpp — do not wire them to `--metal` emission, that turns fail-open into fail-closed.)

**Process priority (P3):** whisper-cli + AudioAnalysis spawns are wrapped with `taskpolicy -c utility` so the Swift audio capture (which keeps default priority) never starves during a live recording. Applies to live + batch passes alike (the live path stays *un-gated* per P1 — QoS only yields CPU under contention, it never stalls production). Fail-opens to no wrapping when `taskpolicy` is absent. Gated by `lowerProcessPriority` (default `true`). See `process-priority.ts`.

`cleanText()` in `transcriber.ts` filters:
- Noise tokens: `[music]`, `(applause)`, `♪`, `♫`
- Russian hallucination patterns: subtitle credits, channel intros, "thank you for watching", etc.
- Empty results after cleaning are skipped entirely

Prompt defaults to: `"Разговор на русском языке. Консультация, обсуждение, вопросы и ответы."` (configurable in config)

Phrasebook (`phrasebook.json` in the project root) applies custom replacements to all transcript output. Per-rule keys: `from`/`to` (required), `caseInsensitive`, `wordBoundary` (literal mode only — wraps in `\b\b`), `regex` (raw JS regex, supports `$1`–`$9` backrefs, makes `wordBoundary` a no-op). `regex: true` has two compile-time guards: a 500-char sanity cap on pattern source (NOT a ReDoS mitigation — catastrophic backtracking is structural, e.g. `(a+)+b` hangs on 30 chars; Node has no regex timeout and `apply()` runs in the sequential live queue, so a backtracking pattern stalls transcription), and empty-match rejection (`a*`/`foo|` would otherwise insert `to` between every char). Invalid regex is silently skipped (no-warnings convention).

Vocabulary (`vocabulary.json` in the project root) folds rare names/terms into the same `--prompt` string (see `vocabulary.ts`) — a soft decoder bias, not a hard override.

## Output Format

### Live Recording

Each meeting gets its own subdirectory: `~/Meetings/2026-05-13_14-30-weekly-standup/transcript.md`

Transcript is written incrementally during recording (append per chunk), then fully rewritten and sorted during finalization.

```markdown
# Weekly Standup — 13.05.2026 14:30

**[14:30:00] Me:** Привет, давайте обсудим квартальные цели...
**[14:30:00] Others:** Конечно, у меня есть все данные...
```

On the final pass, "Others" entries are diarized and renumbered to "Speaker 1", "Speaker 2", ... (see `diarization.ts`), and a `## Talk Time` footer is appended (see `talk-time.ts`). `meet rename` can then attach a real name to a `Speaker N` id (see `speaker-rename.ts`).

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
5. **Diarization** (optional, `diarizationEnabled: true`) — `AudioAnalysis diarize` labels system-audio entries "Speaker N", written to `speakers.json`
6. **Talk-time stats** — per-speaker duration/percentage, appended as a `## Talk Time` footer
7. **Rewrite** — sorted, deduplicated markdown written to output file
8. **Parakeet A/B pass** (optional, `parakeetComparePass: true`) — re-transcribes the same chunks with Parakeet-TDT, writes `transcript.parakeet.md` + `ab-report.json` for manual comparison
9. **opencode index** (optional, `opencodeIndexPass: false`) — generates `index.md` (Summary/Decisions/Action Items) via `runOpencodeIndex()`, fails open (warns, never blocks the transcript)

Finalization can run in background (detached process) or foreground.

## Conventions

- Chunk naming: `mic-001.wav`, `sys-001.wav` (zero-padded 3 digits)
- Speaker labels: mic → "Me"; system audio is diarized on the final pass into "Speaker 1", "Speaker 2", ... (falls back to "Others" when diarization is disabled/unavailable/below `diarizationMinOverlap`) — see `diarization.ts`
- `meet rename <meetingDir> <speakerId> <newName>` renames a diarized label to a real name after finalization (session dir is already gone by then, so it patches the output dir directly) — see `speaker-rename.ts`
- Git repo context: `meet start` captures it from `--repo <path>` (default: cwd) and persists a `- Repo: <name> @ <short sha> (<branch>)` line in `meta.md` + `session.json`. Fail-open silently when not in a repo. `meet link <meetingDir> <repoPath>` re-attaches/replaces it post-hoc. `meet dashboard` surfaces a `Repo` column. No network, pure local — see `git-context.ts`
- Live attention alerts: sys-channel text checked against `triggers.json` in the project root; on match, macOS notification + terminal recap banner (see `specs/SPEC_ATTENTION_2026-07-17.md`)
- Custom whisper vocabulary: hot-reloadable `vocabulary.json` folded into whisper's `--prompt` (see `vocabulary.ts`)
- Transcription queue: sequential (one whisper-cli instance at a time)
- Graceful shutdown: SIGINT/SIGTERM/q → stop capture → rescan → drain queue → finalize
- Atomic writes: always `.tmp` → `rename()`
- No comments in code unless explaining a non-obvious gotcha
- Tests: `node:test`, files named `*.test.ts` alongside source
- ESM imports: all imports use `.js` extensions despite `.ts` source (Node16 module resolution)

### Lock System

Three file-based locks in `locks.ts`:
- **Active recording** (`~/.meet/sessions/active-recording.lock`): prevents concurrent recordings, contains PID for stale detection
- **Finalizer** (`{sessionDir}/finalizer.lock`): prevents duplicate finalization, uses `O_EXCL` for atomicity
- **Global final-pass** (`~/.meet/sessions/final-pass.lock`): serializes heavy medium-model passes across all sessions

All locks use `isPidAlive()` (via `process.kill(pid, 0)`) to detect dead processes and auto-clean stale locks.

### Documentation & Website Sync

`docs/` is a Jekyll site deployed to GitHub Pages by `.github/workflows/pages.yml` (Actions build, **not** the Pages auto-build — it needs `npm install` for `clamp-size`). Responsive typography/spacing use the `clamp-size` npm package via `sass.load_paths: [node_modules]`. There is no gem theme — a custom `docs/_layouts/default.html` + `docs/assets/css/style.scss`.

**Bilingual.** English lives at the site root; Russian mirrors it under `docs/ru/` (same page slugs: `docs/ru/index.html`, `docs/ru/features.md`, `docs/ru/quickstart.md`). `page.lang` is auto-injected by `_config.yml` `defaults` (root→`en`, `ru/`→`ru`); the layout routes nav through a `/ru` prefix, localizes nav labels, renders an `EN | RU` switcher computed from `page.url`, and emits `hreflang` pairs. Code blocks, CLI commands, flags, and paths are **never** translated — only prose.

When a CLI command, config flag, or user-facing feature is **added, changed, or removed**, update **all four** in the same change (the two `docs/` markers must stay byte-identical between languages so the same marker name resolves on both pages):

1. `src/cli.ts` (source of truth)
2. `README.md` — CLI Commands table, Features list, Configuration table
3. `docs/` (English) — edit the matching `<!-- SECTION:... -->` / `<!-- FEATURES:... -->` block (see marker map below). The marker names are the contract; do not edit outside a marker without adding a new named block. Close each block with the matching `<!-- /SECTION:... -->`.
4. `docs/ru/` (Russian) — edit the **same-named** marker block, translating prose only.

Marker map (applies to both `docs/<file>` and `docs/ru/<file>`):
- `index.html`: `SECTION:hero`, `SECTION:why`, `SECTION:features-highlight`, `SECTION:cta`
- `features.md`: `FEATURES:core-recording`, `FEATURES:transcription-quality`, `FEATURES:speaker-identification`, `FEATURES:ab-comparison`, `FEATURES:live-attention`, `FEATURES:finalization`, `FEATURES:post-processing`, `FEATURES:import-batch`, `FEATURES:reliability`, `FEATURES:cli-reference`, `FEATURES:config-reference`

Local preview: `cd docs && bundle install && npm install && bundle exec jekyll serve` → http://127.0.0.1:4000/meet/ (EN) / http://127.0.0.1:4000/meet/ru/ (RU). Push to `master` triggers a deploy; check the Actions tab if the site doesn't update. `docs/package-lock.json` and `docs/Gemfile.lock` are committed for reproducible CI.

## Critical Gotchas

### Swift Audio

- **VoiceProcessing IO 9-channel bug**: `setVoiceProcessingEnabled(true)` silently changes output to 9 channels. Do NOT use `AVAudioConverter` — it crashes. Extract channel 0 manually, resample with linear interpolation.
- **System audio ducking**: set `voiceProcessingOtherAudioDuckingConfiguration` with `enableAdvancedDucking: false, duckingLevel: .min`
- **Core Audio process tap** (system audio, macOS 14.2+): `CATapDescription`'s convenience initializers are all `NS_REFINED_FOR_SWIFT` with no Swift overlay shipped in the SDK — Swift only sees the `__`-prefixed selectors (e.g. `CATapDescription(__monoGlobalTapButExcludeProcesses:)`), confirmed via `swiftc -typecheck` against the real SDK headers, not guessed
- **Atomic chunk handoff**: write `*.wav.tmp`, finalize header, close, then `rename()` to `*.wav`

### Transcription

- Binary: `whisper-cli` (from `brew install whisper-cpp`, NOT `whisper`)
- Live invocation: `whisper-cli -m ggml-small.bin -l ru -f <wav> --no-timestamps -otxt -of <base> --suppress-nst ...` (wrapped in `taskpolicy -c utility` per P3; no `--metal` — whisper.cpp has no such flag, GPU is on by default)
- Import invocation: `whisper-cli -m ggml-medium.bin -l ru -f <wav> -oj -of <base> -sow --max-len 300 ...` (foreground user batch, no QoS wrapping)
- Models: `ggml-small.bin` (466MB, live), `ggml-medium.bin` (~1.5GB, final pass)
- `whisper-cli --help` writes the option list AND backend-init log to **stderr** (stdout is empty) — `detectWhisperCompute` parses stderr to report the active device in `meet doctor`

## Reference

- **Scripta** (github.com/thehwang/Scripta) — dual-channel meeting transcription, documented audio pitfalls
- **whisper.cpp** (github.com/ggml-org/whisper.cpp) — C/C++ Whisper with Metal backend
- Swift audio pitfalls skill: `.opencode/skills/swift-audio/SKILL.md`
