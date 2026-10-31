# Project review — 2026-10-30

Deep review of the working tree at commit `34cfd25` ("feat(menubar): add Reset Notch Panel menu item"). Scope: the whole TypeScript pipeline and CLI, the Swift capture/menu-bar layer, tests, CI/release tooling, and the documentation claims that describe them. The 2026-09-23 review (`specs/REVIEW_CODEBASE_2026-09-23.md`) was used as the baseline for open-item status.

No application code was changed as part of this review.

**Verdict.** This is a thoughtfully designed and unusually well-documented project. The core architecture — file-based Swift↔Node handoff, atomic WAV/JSON writes, token-checked locks, sequential whisper queue — is sound, and most of the previous review's P2 findings are genuinely fixed. The main risk is now the safety net rather than the design: CI has not successfully run the Node tests since 2026-09-18, the highest-risk orchestration has no end-to-end tests, and several realistic paths still silently drop transcript text or audio.

---

## Validation baseline

- `npm run lint`: clean.
- `npm test` on Node 26: **739 tests / 148 suites**; with an isolated `HOME`, **738 pass**. The only failure was `/bin/ps` being blocked by this review's sandbox.
- With the real `HOME` (in this sandbox), 9 fail: `storage.test.ts` tries to create directories under the real `~/.meet/sessions`, and `ps` is blocked. Both are environment symptoms, but the former is itself evidence for the test-isolation finding (P3).
- Local `master` is **6 commits ahead of `origin/master`**; `v1.1.0` exists only locally. The last two CI runs on `origin/master` failed at the "Run tests" step (run `35330755257`).
- Runtime probes used the built `dist/`: `getSystemPressure`/`parseFreeMemoryMb`, `cleanText`, `filterEntries`, `runMicEchoAttributionStep` + `computeTalkTime`, `finalize --background`, `setup`, and `start --calendar-hard-cap`. Node 20.20.2 was used to reproduce the test-runner behavior.

Not exercised: real audio hardware, TCC prompts, live Whisper/AudioAnalysis inference, and real multi-process lock interleavings.

---

## What is working well

- **Process hygiene:** every external binary is invoked with `execFile`/`spawn` and argv arrays; transcript text is passed as data, including the AppleScript notification path (`on run argv`). No shell interpolation of user content.
- **Atomicity:** WAV `*.wav.tmp` → rename, transcript writes via tmp+rename, config writes, and session writes all follow the same discipline.
- **Lock design:** atomic `linkSync` publishing, token ownership on release, PID+`comm` checks, stale-reclaim-only-if-unchanged, and the registry lock's re-entrant depth counter are careful work.
- **Config resilience:** `sanitizeFileConfig` type/range validation with last-known-good fallback and mtime-guarded reload is the right shape for a long-running recorder.
- **Documentation and specs:** far above average. The specs explain *why*, not just *what*.
- **Test breadth:** 39 test files across the modules; most suites use temp dirs and fake executables rather than the developer's real state.

---

## P1 — fix before the next release

### P1-1. CI never runs the Node tests (and the suite is not Node-20 clean)

`package.json` runs `node --test dist/**/*.test.js`. npm executes scripts with `sh`, where `**` is not globstar; `dist/` is flat, so the shell passes the literal string through. **Node 20 does not expand test-runner globs**, so the step fails with `Could not find '…/dist/**/*.test.js'` — exactly what the CI log shows. Node 26 expands it, which is why local runs are green.

Consequences:

- CI has effectively had **no Node test signal** on master/PRs since the last two pushes.
- Once the glob is fixed, three suites still fail on Node 20 because they call `t.test()` without `await`: `src/mic-echo.test.ts` (`attributeMicChunk`, `hasSysCounterpart`) and `src/finalize.test.ts` (`applyLabelOverridesToTalkTime`). Node 20 cancels the un-awaited subtests; Node 26 happens to run them.

**Fix:** use `"test": "tsc && node --test dist"` (or `dist/*.test.js`), bump CI to Node 22/24, `await` every `t.test()`, and assert that the runner executed a nonzero number of tests so a zero-match glob can never pass silently.

**Files:** `package.json:33`, `.github/workflows/ci.yml:21`, `.github/workflows/ci.yml:35`, `src/mic-echo.test.ts:43`, `src/mic-echo.test.ts:85`, `src/finalize.test.ts:482`.

### P1-2. The heavy-pass pressure gate is miscalibrated twice, and its config is dead code

`src/system-monitor.ts:62` hardcodes `pageSize = 4096`, while Apple Silicon `vm_stat` prints `page size of 16384 bytes`. `readFreeMemoryMb()` never passes the header value. Verified live: the parser reports **771 MB** when the machine actually has **~3.0 GB** free+inactive (a 4× underestimate).

Effects:

- `summaryMemThresholdMb: 768` marks a healthy Apple Silicon Mac "overloaded", so rolling summaries pause.
- `gateFreeMemMb: 2048` means heavy finalization/diarization/Parakeet passes hold for up to `gateBudgetMs` (120 s) **per pass** before the deadline fails open.

On top of that, `src/system-monitor.ts:272` computes `const thresholds = resolveGateThresholds(config)` and never uses it: `src/system-monitor.ts:289` calls `sensor()` with no arguments, and the default sensor uses hardcoded `DEFAULT_PRESSURE_THRESHOLDS` (load > 6, free < 768 MB). So `gateLoadAvg`, `gateFreeMemMb`, and the documented "0 = 70% of cores" rule have **no effect on real runs**.

**Fix:** parse the page size from `vm_stat`'s header (fallback 4096) or `sysctl -n hw.pagesize`; pass the resolved thresholds into the sensor or evaluate `cpuLoad1min`/`freeMemoryMb` against them inside `throttleHold`. Add a regression test with a `16384` header and a sensor that records its argument.

**Files:** `src/system-monitor.ts:62`, `src/system-monitor.ts:82`, `src/system-monitor.ts:232`, `src/system-monitor.ts:272`, `src/system-monitor.ts:289`, `src/system-monitor.test.ts:60`.

---

## P2 — silent data loss or wrong output in realistic scenarios

### P2-1. `cleanText()` deletes legitimate meeting sentences

`src/transcriber.ts:18` applies broad patterns **per sentence** (`src/transcriber.ts:64`), dropping the entire sentence. Probe against the built module:

| Input | Output |
|---|---|
| `Просим прощения за задержку, сейчас всё настроим.` | `""` |
| `Корректор проверил текст договора, всё в порядке.` | `""` |
| `Плановые технические работы начнутся в субботу, сервис будет недоступен.` | `""` |
| `Это была консультация, обсудили вопросы и ответы по проекту.` | `""` |

These are normal business/ops sentences. `корректор` is matched bare, and `консультация.*вопросы.*ответы` is exactly the kind of language the default prompt encourages.

**Fix:** anchor patterns to the stock hallucination phrasing as a whole sentence (or require a short sentence / no other content words), and add negative tests for legitimate usage.

**Files:** `src/transcriber.ts:18`, `src/transcriber.ts:64`, `src/transcriber.test.ts:51`.

### P2-2. An unreadable WAV is treated as a successful silence verdict

`src/audio-metrics.ts:65` catches any read failure and returns `rmsDb: -Infinity`. `src/final-pass.ts:67` then marks the chunk `audible = false`; `src/final-pass.ts:135` records it as empty text and adds it to `completedKeys`. Finalize's safety net skips completed keys (`src/finalize.ts:924`), and the unrecovered-audio check treats the chunk as successful, so `src/finalize.ts:1098` removes the session directory — including `entries.jsonl` and the WAV — with no warning.

Result: a transient EIO/EACCES/truncated WAV can discard live transcript text and the only recovery artifacts.

**Fix:** distinguish "read failed" from "silent" in `analyzeWavFileWithSamples`, propagate the failure into `failedKeys`, and preserve the session directory.

**Files:** `src/audio-metrics.ts:65`, `src/final-pass.ts:67`, `src/final-pass.ts:135`, `src/finalize.ts:924`, `src/finalize.ts:1061`, `src/finalize.ts:1098`.

### P2-3. The audio-only echo gate can delete the user's speech when the sys channel has no text

`src/final-pass.ts:205` sets `micEchoScore` from envelope correlation alone; `src/filters.ts:142` drops on that score **before checking whether the sys channel produced any text**. Verified with the built filter:

- mic: `"это важная реплика пользователя"`, `micEchoScore: 1.0`
- sys: `""` (but continuous audio above `sysRmsThresholdDb`, e.g. music/HVAC)
- result: mic entry **dropped**, no sys entry kept.

Because the chunk is also in `completedKeys`, the session directory is then deleted.

**Fix:** require a non-empty sys counterpart (same index or ±1 neighbourhood) before a P2 drop, mirroring `hasSysCounterpart`.

**Files:** `src/final-pass.ts:205`, `src/filters.ts:142`, `src/finalize.ts:924`.

### P2-4. Talk Time re-counts echo as "Me" when every attributed mic chunk is dropped

`src/finalize.ts:981` derives `micSegmented` from **emitted** mic segments. `runMicEchoAttributionStep` skips dropped chunks inside `buildMicSegments`, so when *all* attributed chunks are dropped as sys-covered echo, `micSegments` is empty, `micSegmented` is false, and `computeTalkTime` falls back to chunk counting over the still-loud mic RMS records.

Reproduced: a 600 s listen-only meeting yields **`Me 600 s (50%)` + `Speaker 1 600 s (50%)`, total 1200 s**.

**Fix:** have the mic-echo step return `segmented: attributed.size > 0` (or include its drops in the excluded keys) and pass that to `computeTalkTime`; add the all-dropped fixture as a regression test.

**Files:** `src/finalize.ts:981`, `src/mic-echo.ts:218`, `src/mic-echo.ts:239`, `src/talk-time.ts:85`.

### P2-5. The recorder can miss capture startup failure and hang for the whole cap

`src/recorder.ts:92` awaits `startCapture()`. The process `exit` listener is only attached at `src/recorder.ts:233`, *after* two awaits (`writeAtomic(session.json)` at `src/recorder.ts:196` and `writeActiveRecordingLock` at `:200`). If the capture dies in that window (TCC denial, macOS < 14.2, crash), both listeners miss the event: `captureExited` stays false and `run()`'s promise never settles.

The no-text timeout cannot rescue it because `latestProcessedOffsetSeconds` stays 0, so the UI prints "Recording … mic 0, sys 0" until max-duration (75 min) — or forever with `--max-duration 0`.

**Fix:** attach one `exit` handler immediately after `spawn`, before any await, and have `run()` also check `captureProcess.exitCode !== null`.

**Files:** `src/recorder.ts:92`, `src/recorder.ts:196`, `src/recorder.ts:233`, `src/recorder.ts:636`.

### P2-6. Ctrl-D at the opencode prompt permanently disables the control loop

`src/recorder.ts:772` calls `stopStatus()` before `rl.question`, but `startStatus()` only runs inside the question callback (`src/recorder.ts:780`, `src/recorder.ts:802`). Node emits `close` on EOF/Ctrl-D and does **not** invoke a pending `question` callback (verified). Result: `opencodeRunning` stays true, the 5 s status interval is gone, and `checkAutoStop()` never runs again — max-duration, no-text, and calendar hard caps are silently disabled while capture continues.

**Fix:** add `rl.on("close", …)` that resets the guard and restarts the status loop idempotently.

**Files:** `src/recorder.ts:762`, `src/recorder.ts:772`, `src/recorder.ts:780`, `src/recorder.ts:802`.

### P2-7. Several commands report success when they failed

Verified with the built CLI:

- `meet setup` prints "Some checks failed" and exits **0** (`src/cli.ts:496`–577). `meet doctor` exits 1 on failure, so scripts cannot use either consistently.
- `meet finalize --background /nonexistent` prints "Background finalizer started" and exits **0** (`src/cli.ts:91`–98); the child's error is discarded. The recorder's `q`/`s`/`n` paths have the same blind spot.
- `meet transcribe` catches per-file failures and never sets an exit code (`src/import.ts:84`–102); a file with no speech is recorded as `success: true` (`src/import.ts:86`).
- `src/main.ts:4` uses `parse()` with async actions, so expected errors print a raw stack trace instead of a one-line message. Reproduced with `meet start --max-duration 10 --calendar-hard-cap 10`.

**Fix:** set `exitCode = 1` on failed checks/files, validate the session directory before backgrounding, propagate spawn/child startup, and use `parseAsync()` with Commander error mapping.

**Files:** `src/cli.ts:91`, `src/cli.ts:496`, `src/import.ts:84`, `src/import.ts:86`, `src/main.ts:4`.

### P2-8. The menu bar can be wedged in "Recording" by an attached session

`native/MenuBar/Sources/MeetMenuBar/RecordingController.swift:390` only checks whether `active-recording.lock` still **exists**. For an attached CLI session there is no `Process`, so nothing verifies the PID. If node is `SIGKILL`ed (or the terminal closes; there is no `SIGHUP` handler), the lock stays on disk and the UI counts forever; Stop signals a dead PID and manual Start is refused by `guard state == .idle` until relaunch.

**Fix:** when `process == nil` and `attachedPid != nil`, verify the PID/comm and call `handleTermination()` plus stale-lock cleanup when it is dead.

**Files:** `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift:390`, `native/MenuBar/Sources/MeetMenuBar/SessionMonitor.swift:20`.

### P2-9. Swift storage-error budget can never trip for write failures

`native/AudioCapture/Sources/AudioCapture/MicCapture.swift:296` resets `writerErrorCount = 0` after a successful `startChunk()` in the **recovery** path. Creating the 44-byte header proves only that file creation worked; the append/finalize failure that caused the error has not been fixed. So a persistent data-write failure cycles "append fails → reopen header → count reset", `writerFailed` stays false, and the stream silently records nothing. `CaptureRunner`'s all-streams-halted check never fires. Same logic in `SystemAudioCapture.swift`.

**Fix:** reset the counter only after a successful append, and count consecutive failures across buffers.

**Files:** `native/AudioCapture/Sources/AudioCapture/MicCapture.swift:260`, `native/AudioCapture/Sources/AudioCapture/MicCapture.swift:296`, `native/AudioCapture/Sources/AudioCapture/SystemAudioCapture.swift:164`, `native/AudioCapture/Sources/AudioCapture/main.swift:144`.

---

## P3 — worth scheduling

| Area | Finding | Where |
|---|---|---|
| Final transcript ordering | Final pass pushes sys before mic at the same chunk, while live/`entriesFromSession` puts Me first. The newest real transcript shows "Яна/Others" lines before "Me"; inconsistent with the documented format. | `src/filters.ts:127`, `src/filters.ts:183`, `src/assembler.ts:29` |
| Extend on unlimited | `extendCap()` turns `--max-duration 0` (unlimited) into a 15-minute cap when the user presses Extend. Keep 0 as 0. | `src/recorder.ts:747` |
| Fractional caps | Auto-extend sets `maxDurationMinutes = elapsed/60 + 5`; `formatClock` prints `sec % 60` without rounding, so the status line can show `cap: 04:59.3999…` and stop messages print fractional minutes. | `src/recorder.ts:912`, `src/auto-stop.ts:49` |
| Dead system-audio health warning | `sys_missing` is declared but never emitted; only `checkMicMissing` exists. A denied/dead system tap in `full` mode silently produces a mic-only transcript. | `src/capture-health.ts:5`, `src/capture-health.ts:91` |
| PID reuse | `isPidAlive(pid, { comm: "node" })` accepts any live node process with a recycled PID. A stale lock can look permanently live, blocking `meet start` and (via `gateWhileRecording`) all heavy passes. Verify start time/cmdline, not just the name. | `src/locks.ts:40` |
| JSONL-only entries | `buildBaseResults` ingests all `entries.jsonl` text, but `entriesFromSession` iterates only `session.processedChunks`; JSONL records for chunks missing from `session.json` never become transcript entries. | `src/finalize.ts:235`, `src/assembler.ts:17` |
| Torn JSONL append | `appendEntryRecord` appends blindly; a crash mid-line makes the next record join the torn line and be skipped. Ensure a trailing newline before appending and resync on read. | `src/entries-store.ts:5`, `src/entries-store.ts:25` |
| NUL bytes in source | `src/diarization-ab.ts` contains literal `\0` bytes, so git/GitHub treat the file as binary and line diffs are unavailable. Use `"\u0000"`. | `src/diarization-ab.ts:44` |
| Progress-writer race | `dispose()` clears the timer but cannot cancel an in-flight `writeAtomic`; a late flush can overwrite the terminal `done`/`error` `session.json` on the preserved-session path. | `src/finalize.ts:62`, `src/finalize.ts:1044` |
| Swallowed `speakers.json` | The write is `.catch(() => {})`; a failure leaves transcript labels that `meet rename`/`speakers suggest` cannot resolve. | `src/finalize.ts:1012` |
| `speakers suggest` quoting | The command prints unescaped `meet rename <dir> "<id>" "<name>"`. Paths with spaces break; a calendar attendee containing quotes/backticks produces an injection when copy-pasted. | `src/speakers-suggest.ts:75` |
| Test isolation | `storage.test.ts` creates `meet-test-stale-*` under the real `~/.meet/sessions`; there is no `setSessionsDirForTest` seam in `storage.ts` (locks has one). On a crash before `afterEach`, the next `meet start` reports stale sessions. | `src/storage.test.ts:160`, `src/storage.ts:55` |
| Flaky time assertions | Summary-scheduler tests use fixed 5–30 ms sleeps; final-pass tests assert `elapsed < 100 ms` under a parallel runner. Prefer `awaitIdle()`/polling; keep only generous hang bounds. | `src/summary-scheduler.test.ts:240`, `src/final-pass.test.ts:96` |
| Docs drift | README says `meet ask [question]` (actual: `<sessionDir> <question>`), "Queue tags" (actual: replace), and documents `--allow-degraded`, which the CLI never registers. AGENTS says 60 min default (code: 75) and turbo final (code: medium); CLAUDE says 15 s chunks (code: 30). This violates the project's own docs-sync rule. | `README.md:82`, `README.md:86`, `README.md:105`, `AGENTS.md:92`, `AGENTS.md:97`, `CLAUDE.md:319` |
| Release/CI gates | The macOS CI job only runs `swift build`, never the MenuBar `--self-test-*` asserts; `release.yml` runs no tests and does not check that the tag matches `package.json`; the tag is interpolated into a shell command. | `.github/workflows/ci.yml:38`, `.github/workflows/release.yml:22`, `.github/workflows/release.yml:29` |
| macOS floor | `LSMinimumSystemVersion` is 13.0, but full-mode system capture requires 14.2 and the CLI never passes `--allow-degraded`; on 13.x/14.0–14.1 the default `meet start` fails with a misleading TCC alert. | `native/MenuBar/Info.plist:12`, `native/AudioCapture/Sources/AudioCapture/main.swift:107`, `src/recorder.ts:161` |
| Calendar edge cases | Overlap losers are resolved before the winner actually starts; if the winner is skipped for missing mic permission, the loser is lost for that occurrence. `store.reset()` races the background fetch, and a failed spawn retries a modal alert every 20 s. | `native/MenuBar/Sources/MeetMenuBar/CalendarAutoStartController.swift:212`, `:143`, `:245` |
| WAV writer | `abortCurrentChunk` does not clear `carry`, so up to ~85 ms of audio from an aborted chunk is replayed into the next one. A tap callback that passes the `isRunning` guard before `stop()` can enqueue writer work after `flushPartial`, leaving an orphan `.tmp`. | `native/AudioCapture/Sources/AudioCapture/WAVWriter.swift:124`, `native/AudioCapture/Sources/AudioCapture/MicCapture.swift:356` |
| Attendee names | `attendeeNames` keeps declined attendees and rooms/resources, then joins with commas and re-splits in `cli.ts`; "Doe, John" becomes two prompt terms. Filter status/type and pass names individually. | `native/MenuBar/Sources/MeetMenuBar/CalendarAutoStartController.swift:252`, `src/cli.ts:361` |
| Pipeline startup errors | `Pipeline.start()` fire-and-forgets `rescan()` (an unhandled `readdir` rejection is fatal on Node ≥20) and the chokidar watcher has no `error` listener; an fs.watch failure can kill the recorder while capture keeps writing. | `src/pipeline.ts:87`, `src/pipeline.ts:99` |
| Pause/resume write rejection | SIGUSR1/USR2 handlers call `void togglePause()`, which ends in an unawaited `writeAtomic`; a disk-full error becomes an unhandled rejection and Node exits with the capture still alive. | `src/recorder.ts:720`, `src/recorder.ts:813` |
| WavIO robustness | `WavIO` ignores the `fmt` sample rate and format tag, hardcoding 16 kHz at the call sites, and loads the whole WAV into `Data` + `[Float]` (~0.7 GB peak for a long `sys-concat.wav`). | `native/AudioCapture/Sources/AudioAnalysis/WavIO.swift:46` |

---

## Real-world quality observation

The newest finalized meeting (`2026-10-30_15-33-meeting`) is evidence beyond unit tests. It is 13m30s long, but `speakers.json` reports **915 s total** (`Me 660 s + Яна 255 s`), because the same echoed speech is counted on both channels. The transcript's `Me` lines repeat the far end almost verbatim (the first `Me` line mirrors `Яна`'s opening sentence), and `micEchoAttribution` only matched **2 of 8** candidate mic chunks.

That is not a one-line bug — it is a limitation of whole-chunk echo attribution: mixed chunks (user + leak) keep the "Me" label, and talk time sums the two channel timelines. It is the most visible quality gap in real output. Sentence-level dedup against the sys transcript, or subtracting overlapping sys-speaker spans from mic "Me" time, would move the needle more than further threshold tuning.

---

## Status of the 2026-09-23 review

- **Fixed:** N2 (per-key restore), N4 (`mkdir` before output writes), N5 (finalizer spawn checks), N6 (awaited session write), N7 (registry lock order), N8 (lock test seam + depth reset), N9 (Swift pause/resume state), N10 (`--cleanup=verbatim`).
- **Partially fixed:** N1 — final-pass drops are excluded from "Me", but the all-dropped mic-echo case still double-counts (P2-4).
- **Residual:** N3 — `dispose()` does not wait for an in-flight progress write (P3, progress-writer race).

---

## Recommended order of work

1. **Restore CI first:** fix the test command, pin Node 22/24, await the subtests, assert a nonzero test count. Do not merge new features on a red/absent suite.
2. **Fix the pressure gate:** page size + pass the configured thresholds. Low effort, immediate effect on every finalize and live summary.
3. **Close the silent data-loss paths:** unreadable WAV, echo-drop without sys text, `cleanText` false positives, and the mic-echo talk-time flag. These are the cases that make users distrust the transcript.
4. **Add end-to-end tests** with fake `whisper-cli`/`AudioAnalysis` for `finalizeSession`, `Recorder`, and the active/global locks; move `storage.test.ts` off the real `~/.meet`.
5. **Then** the CLI exit codes, menu-bar PID re-check, and docs sync — all straightforward once the safety net is real.
