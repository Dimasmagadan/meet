# SDD Spec: Safety-Net Fixes (REVIEW_CODEBASE_2026-10-30 remediation)

**Date:** 2026-10-31
**Status:** Implemented (all phases §2-§7 landed with their regression tests; §8.2 acceptance: local Node 24 + Node 26 green, test:swift green, zero-match guard proven, NUL check clean — CI-green-on-github and the live-recording smoke remain to be verified on push)
**Owner:** Dmitrii Diakonov
**Source:** `specs/REVIEW_CODEBASE_2026-10-30.md` (all P1/P2/P3 findings verified against the working tree at `34cfd25`)

---

## 1. Overview

The 2026-10-30 review found the design sound but the safety net broken: CI has not successfully run the Node tests since 2026-09-18, the pressure gate ignores its own config, and several realistic paths silently drop transcript text or audio. This spec fixes every P1/P2 finding and the scheduled P3 batch, and adds the regression tests that make each class of bug non-recurring.

The trigger for this spec was a meta-failure: a health-check summary reported the project healthy ("nothing here is on fire") while CI had been red for six weeks. §2 turns that into a hard contract, not a hope.

### Guiding principles

- **Every fix lands with its regression test in the same commit.** The test must be shown failing against the pre-fix code (write test → confirm it reproduces → fix).
- **Fail closed on data, fail open on convenience.** Unreadable audio must never look like silence; a missing config gate must never silently disable a check that the user asked for.
- **No behavior change for happy-path output.** Transcript text, speaker labels, and CLI stdout formatting stay byte-identical in the passing cases (except where §4.1 explicitly widens `cleanText`).

### Phases (in the review's recommended order)

| Phase | Scope | Review items |
|-------|-------|--------------|
| §2 | Failure-surfacing contract (CI, test runner, release gates, agent rules) | P1-1, P3 release/CI gates |
| §3 | Pressure gate calibration | P1-2 |
| §4 | Silent data loss | P2-1, P2-2, P2-3, P2-4 |
| §5 | Recorder & CLI honesty | P2-5, P2-6, P2-7 |
| §6 | Swift fixes | P2-8, P2-9 |
| §7 | P3 batch | all P3 rows |
| §8 | Regression matrix & acceptance criteria | — |

Do not merge new features while §2 is unlanded.

---

## 2. Phase 0 — Failure-surfacing contract

### 2.1 Test runner command (P1-1a)

`package.json:33` runs `node --test dist/**/*.test.js`. npm executes scripts with `sh`, which does not globstar-expand; the literal string reaches Node. Node 20's test runner does not expand test-runner globs → `Could not find '…/dist/**/*.test.js'` (verbatim in CI run `35330755257`). Node 26 expands it, which is why local runs are green.

**Fix:**

```jsonc
// package.json
"test": "tsc && node scripts/run-tests.mjs"
```

New `scripts/run-tests.mjs` (~40 lines):

1. Spawns `node --test dist` (directory form — no glob at any Node version), streaming output through unchanged (`stdio` piping so the human still sees the spec reporter).
2. Parses the summary line (`/tests (\d+)/` from either the spec reporter's `ℹ tests N` or TAP's `# tests N`).
3. **Exits 1 with an explicit message if the parsed test count is < 1** — this is the guard that makes a zero-match test file pattern fail loudly instead of passing silently.
4. Propagates the child's exit code.

### 2.2 CI Node version (P1-1b)

`.github/workflows/ci.yml:21`: bump `node-version: '20'` → `'24'`. Node 24 is the active LTS; the suite must also stay green on the developer's Node 26 (both are exercised in acceptance, §8).

### 2.3 Await every subtest (P1-1c)

Node's test runner cancels subtests whose parent finished first; whether they "happen to run" is version luck. Deterministic on every version:

- `src/mic-echo.test.ts:44,50,55,63,69,79,91,95,100` — nine `t.test(...)` calls without `await`.
- `src/finalize.test.ts:482` — the `applyLabelOverridesToTalkTime` parent callback is sync; its inner `t.test(...)` calls are not awaited.

**Fix:** make each parent callback `async` and `await` every `t.test()`. Convention note (AGENTS.md §Conventions): "Every `t.test()` is awaited; an un-awaited subtest is cancelled whenever its parent finishes first, which is version-dependent."

### 2.4 Sentinel: the suite must have substance (P1-1d)

The §2.1 count guard covers the zero-match case. A second guard covers the "runner silently scanned the wrong directory" case: CI's "Run tests" step additionally asserts, via `scripts/run-tests.mjs`, that the parsed count is **≥ 100** (current: 739). A config value `MIN_EXPECTED_TESTS = 100` sits at the top of the script with a comment pointing at this spec. If the suite legitimately shrinks below the floor, the floor is lowered in the same commit that explains why.

### 2.5 Release workflow runs the tests (P3 release/CI gates)

`.github/workflows/release.yml` runs no tests and does not check the tag against `package.json`; the tag is interpolated into a `run:` shell block.

**Fix:**

1. New step before "Extract release notes": `npm ci && npm test` (ubuntu, Node 24 — the tests are platform-independent by design).
2. New step: verify the pushed tag matches `package.json` — `node scripts/check-release-tag.mjs "${{ github.ref_name }}"` (compares `v<version>`; exits 1 on mismatch).
3. All `${{ github.ref_name }}` interpolations move into `env:` block variables (`env: TAG: ${{ github.ref_name }}`) and the `run:` block uses `"$TAG"` — no script text is ever composed from workflow input.
4. The macOS CI job (`ci.yml:38`) adds a final step `npm run test:swift` so the MenuBar `--self-test-*` asserts (notch, calendar, and the new §6 ones) run in CI instead of only locally.

### 2.6 Agent failure-reporting rules (the meta-fix)

New AGENTS.md subsection under Conventions:

> ### Agent failure-reporting rules
> - Any `npm test` / `npm run lint` / CI run observed to fail must be reported to the user verbatim: suite name and the first failing assertion. A failing or unrun suite is never summarized as healthy.
> - Health claims ("tests pass", "CI green") require evidence produced in the same session: the actual run output, or `gh run list --limit 3` for CI state. **No CI run at all is a finding, not a pass.**
> - A review or health check must inspect the test command and recent CI runs before praising the codebase (P1-1 in `specs/REVIEW_CODEBASE_2026-10-30.md` is the case study: six weeks of red CI reported as "nothing on fire").

### 2.7 Tests for Phase 0

| Test | Asserts |
|---|---|
| `scripts/run-tests.mjs` self-test (manual, in acceptance) | With `dist` renamed away, the wrapper exits 1 with the zero-match message, not 0 |
| `src/test-runner.test.ts` (new) | Parses a fixture spec-reporter and TAP summary → count extracted; input without a summary line → exit-1 path flagged. Pure-parser tests, no subprocess |
| `.github` | YAML lint by inspection; CI green run on github.com is the real test |
| `src/cli.test.ts` | Command registry still lists every command (existing test) — guards against accidental removal while touching `package.json`/`main.ts` |

---

## 3. Phase 1 — Pressure gate calibration (P1-2)

Two independent bugs in `src/system-monitor.ts`, verified live: free memory reported **796 MB** when **3186 MB** was reclaimable (4× underestimate), and `gateLoadAvg`/`gateFreeMemMb` are dead config.

### 3.1 Page size

`parseFreeMemoryMb` (`system-monitor.ts:62`) defaults `pageSize = 4096`; `readFreeMemoryMb` (`:82`) never passes one. Apple Silicon `vm_stat` prints `page size of 16384 bytes`.

**Fix:**

1. `parseVmStatPageSize(stdout: string): number | null` — parses `/page size of (\d+) bytes/` from the `vm_stat` header.
2. `readFreeMemoryMb()`: page size = header value → else cached `sysctl -n hw.pagesize` (resolve once, memoize) → else 4096. Pass it into `parseFreeMemoryMb(stdout, pageSize)`.
3. Keep `parseFreeMemoryMb(stdout, pageSize = 4096)`'s signature — the default stays as a fallback, callers no longer rely on it.

### 3.2 Dead thresholds

`throttleHold` (`system-monitor.ts:272`) computes `const thresholds = resolveGateThresholds(config)` and never uses it; `sensor()` (`:289`) is called with no arguments, so `getSystemPressure` falls back to `DEFAULT_PRESSURE_THRESHOLDS`. Documented `gateLoadAvg` (0 = 70% of cores) and `gateFreeMemMb` have no effect.

**Fix:** bind the resolved thresholds into the default sensor:

```ts
const thresholds = resolveGateThresholds(config);
const sensor = opts.sensor ?? (() => getSystemPressure(thresholds));
```

`PressureSensor`'s type stays `() => Promise<ResourcePressure>` — existing test fakes keep working unchanged.

### 3.3 Tests

| Test | File | Asserts |
|---|---|---|
| `parseFreeMemoryMb handles a 16384-byte vm_stat header` | `system-monitor.test.ts` | Fixture stdout with `page size of 16384 bytes` + real page counts → expected MB (the review's 771-vs-3000 shape); same fixture via 4096 → 4× smaller (documents the old bug) |
| `parseVmStatPageSize` | `system-monitor.test.ts` | Extracts 16384; returns null when the header is absent (older macOS wording) |
| `throttleHold passes resolved thresholds to the sensor` | `system-monitor.test.ts` | Fake sensor records its invocation context; config `gateLoadAvg: 2` non-default → the gate decision in the fake honors it (sensor receives thresholds via closure binding — assert by having `getSystemPressure`'s result be observable; simplest: spy wrapper around `getSystemPressure` asserting it was *not* called with defaults when `gateLoadAvg` is set) |
| `gateFreeMemMb below parsed free memory does not hold the pass` | `system-monitor.test.ts` | With the §3.1 fix, a fixture machine reporting 3186 MB free and `gateFreeMemMb: 2048` → `throttleHold` returns immediately; pre-fix (4096 math → 796 MB) it would hold until deadline |

---

## 4. Phase 2 — Silent data loss

### 4.1 `cleanText()` deletes legitimate meeting sentences (P2-1)

`src/transcriber.ts:18` applies broad hallucination patterns **per sentence** and drops the whole sentence on any match. Verified live — all four of these become `""`:

- «Просим прощения за задержку, сейчас всё настроим.»
- «Корректор проверил текст договора, всё в порядке.»
- «Плановые технические работы начнутся в субботу, сервис будет недоступен.»
- «Это была консультация, обсудили вопросы и ответы по проекту.»

**Fix:** two changes in `cleanText()`:

1. **Dominance rule:** a sentence is dropped only if the matched noise span *dominates* it: after removing all matches, the remaining text has < 2 content words (or matches cover ≥ 60% of non-space characters). A bare `корректор` inside an otherwise real sentence can no longer kill the sentence.
2. **Anchoring:** stock-phrase patterns (`смотрите на нашем канале`, `подписывайтесь`, `благодарим за просмотр`, `корректор`, subtitle credits) are anchored to their hallucination usage — whole-sentence or leading-label forms (`^корректор[.,!:]?`), never bare substrings. The exact pattern list is reviewed in `transcriber.test.ts`.

Token noise (`[music]`, `♪`, `(applause)`) keeps its current per-sentence behavior — these never appear inside legitimate speech.

**Tests** (`transcriber.test.ts`):

- The four sentences above → unchanged (negative tests; these are the canary — if `cleanText` regresses, these fail first).
- Real hallucinations still die: «Подписывайтесь на наш канал!», «Благодарим за просмотр, ставьте лайки», «Смотрите полное видео на канале», «[музыка]».
- Mixed sentence survives: «Благодарим за просмотр мы перейдём к делу» — hmm, this one *is* hallucination-adjacent; the assertion here is: dominance rule drops only when matches cover the sentence. Pin down concrete expectations per pattern in the test file so the intent is explicit.

### 4.2 An unreadable WAV is treated as a successful silence verdict (P2-2)

Chain: `analyzeWavFileWithSamples` catches *any* read failure → `rmsDb: -Infinity` (`audio-metrics.ts:81`) → final pass marks `audible = false` and adds the key to `completedKeys` (`final-pass.ts:144`) → finalize's safety net skips completed keys (`finalize.ts:924`) → unrecovered-audio check re-reads the same WAV with the same broken analyzer, gets `-Infinity` again, concludes "below threshold" → `finalize.ts:1098` deletes the session directory. A transient EIO/EACCES/truncated WAV discards live transcript text and the only recovery artifacts.

**Fix:**

1. `analyzeWavFileWithSamples` returns a discriminated union: `{ ok: true; metrics: AudioMetrics; samples: Int16Array } | { ok: false; error: unknown }`. The catch no longer fabricates silence.
2. `final-pass.ts` `forEachAudibleChunk`: on `ok: false` → `onChunk` with `audible: false, unreadable: true` (new field on the chunk callback type); `runFinalPass` adds the key to **`failedKeys`**, never to `completedKeys`, and pushes no entry.
3. `finalize.ts` `considerKey` (the unrecovered check): `analyzeWavFile` on a `ok: false` result is **unrecovered** — a WAV whose contents cannot be read is never evidence of silence (fail closed).
4. Existing callers of `analyzeWavFile`/`analyzeWavFileWithSamples` are updated to the union; a convenience `analyzeWavFile` keeps returning `AudioMetrics` only for callers that genuinely treat unreadable as not-audible — none should remain after the fix; if any do, they log a warning.

**Tests:**

| Test | File | Asserts |
|---|---|---|
| `unreadable WAV reports ok:false instead of silence` | `audio-metrics.test.ts` | A file with a garbage header → `ok: false`; a 44-byte header-only WAV → `ok: true` with silence metrics (distinguishes "empty but valid" from "broken") |
| `final pass routes unreadable WAVs to failedKeys` | `final-pass.test.ts` | Unreadable chunk → `failedKeys` has the key, `completedKeys` does not, no entry emitted |
| `finalize preserves the session when a chunk WAV is unreadable` | `finalize.test.ts` | Session dir still exists after finalize; `session.status === "error"`; transcript keeps the live text via the restore path (completed-keys skip no longer fires) |

### 4.3 The audio-only echo gate can delete the user's speech (P2-3)

`final-pass.ts:205` sets `micEchoScore` from envelope correlation alone (sys *audio* frames, no text involved); `src/filters.ts:142` drops the mic entry on that score before any sys-*text* check. Verified: mic real speech + `micEchoScore: 1.0` + sys present-but-textless (music/HVAC) → mic entry dropped, nothing kept, chunk in `completedKeys`, session deleted.

**Fix:** in `filterEntries`, the `micEchoScore >= echoFractionThreshold` drop additionally requires a sys **text** counterpart at the same index or N±1 — the filter already builds `sysTokensByIndex`; the gate becomes `hasSysTextNeighbour(idx)` (mirror of `mic-echo.ts`'s `hasSysCounterpart` neighbourhood rule). No counterpart text → the mic entry is kept: envelope correlation against audio that whisper transcribed as nothing is not evidence of echo.

**Tests** (`filters.test.ts`):

- `micEchoScore alone does not drop mic speech when the sys channel has no text` — the review's exact probe: mic `"это важная реплика пользователя"` + score 1.0 + sys textless → kept.
- `sys text at the same index allows the echo drop` → dropped.
- `sys text at N±1 allows the echo drop` (chunk-boundary drift) → dropped.

### 4.4 Talk Time re-counts echo as "Me" when every attributed mic chunk is dropped (P2-4)

`finalize.ts:981` derives `micSegmented` from emitted mic segments (`echoOutcome.micSegments.length > 0`). When *all* attributed chunks are dropped as sys-covered echo, segments are empty → `micSegmented` false → `computeTalkTime` falls back to chunk counting over still-loud mic RMS records → double count. Reproduced: 600 s listen-only meeting → `Me 600 s (50%) + Speaker 1 600 s (50%)`, total 1200 s.

**Fix:** `MicEchoAttributionOutcome` gains `attributedKeys: Set<string>` — every mic chunk the step voice-matched, whether later kept or dropped (the set already exists internally as `attributed`). `finalize.ts`:

```ts
const micSegmented = micOutcome.micDiarSegments.length > 0
  || echoOutcome.micSegments.length > 0
  || echoOutcome.attributedKeys.size > 0;
```

Dropped-but-attributed chunks are counted once via the sys speaker timeline; the mic fallback must not fire.

**Tests:**

| Test | File | Asserts |
|---|---|---|
| `outcome exposes attributedKeys even when all matches are dropped` | `mic-echo.test.ts` | Fixture where every candidate is sys-covered → `attributedKeys.size === candidates`, `micSegments` empty |
| `all-dropped attribution does not double-count Me talk time` | `finalize.test.ts` | 600 s listen-only fixture → talk-time total equals the sys total; no "Me" row fabricated from chunk counts (the review's reproduction, as a permanent regression test) |

---

## 5. Phase 3 — Recorder & CLI honesty

### 5.1 Capture startup failure can hang the recorder for the whole cap (P2-5)

`recorder.ts:92` awaits `startCapture()`; the `exit` listener that sets `captureExited` is attached only at `:233`, after two awaits (`writeAtomic` at `:196`, lock write at `:200`). A capture death inside that window (TCC denial, macOS < 14.2, crash) is missed by both listeners → `run()` never settles, no-text timeout can't fire (`latestProcessedOffsetSeconds` stays 0) → "Recording … mic 0, sys 0" until max-duration, forever with `--max-duration 0`.

**Fix:**

1. Attach the `captureProcess.on("exit", ...)` handler (the one at `:233`) **immediately after `spawn`** (`:171`), before any `await` — session.json and lock writes come after.
2. `run()`, right after `await this.startCapture()`: `if (this.captureExited || this.captureProcess?.exitCode !== null) { this.shutdown(); return ...; }` — covers the spawn-to-listener gap completely.

**Tests** (`recorder.test.ts`):

- `capture exiting during startCapture triggers shutdown` — injectable spawn: `RecorderOptions` gains `spawnCapture?: typeof spawn` (default: real `spawn`, zero change elsewhere). A stub child emits `exit` while the stubbed first `writeAtomic` is still pending → `run()` resolves within 2 s, lock removed.
- `capture exiting before run()'s listener attaches still settles` — stub child already-exited state (`exitCode: 1`, `captureExited` pre-set) → the §5.1.2 check fires without any event.
- Fake binary variant: a `/bin/sh -c 'exit 1'` script via a `captureBinPath` test override (config already resolves `getCaptureBinPath`; add an override hook in `RecorderOptions` alongside `spawnCapture`).

### 5.2 Ctrl-D at the opencode prompt permanently disables the control loop (P2-6)

`recorder.ts:772` stops the status interval before `rl.question`; `startStatus()` only runs inside the question callback. Node emits `close` on EOF/Ctrl-D and does **not** invoke the pending question callback → `opencodeRunning` stays true, the 5 s status tick is gone, `checkAutoStop()` never runs again. No `rl.on("close")` exists (verified: grep is empty).

**Fix:** in `askQuestion()`, add

```ts
rl.on("close", () => {
  if (!this.opencodeRunning) return;      // callback already handled it
  this.opencodeRunning = false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  this.startStatus();
});
```

`startStatus()` becomes idempotent (no-op when the interval already exists). The callback sets `opencodeRunning = false` *before* its own `startStatus()` so the close handler and the callback can't double-start.

**Tests** (`recorder.test.ts`): extract the prompt flow into a testable helper `askOpencode(deps: { stdin, stdout, createInterface?, onResult })`; test drives a `PassThrough` stream: emits `'end'` → `close` fires → guards reset and the status timer is observable again (assert via an injected status callback, not the real interval).

### 5.3 Commands that report success when they failed (P2-7)

| Command | Today | Fix |
|---|---|---|
| `meet setup` (`cli.ts:496–577`) | Prints "Some checks failed" and exits **0** | `if (!ok) process.exitCode = 1` |
| `meet finalize --background /nonexistent` (`cli.ts:91`) | Prints "Background finalizer started (pid N)", exits 0; the detached child's error goes nowhere (`stdio: "ignore"`) | Validate first: `readSession(expandPath(sessionDir))`; on failure print a one-line error and `process.exitCode = 1` without spawning. Also applies to the recorder's `q`/`s`/`n` spawn paths (`recorder.ts:494,544,572`) — warn when `spawnBackgroundFinalizer` returns `undefined` |
| `meet transcribe` (`import.ts:84–102`) | Per-file failures never set an exit code; a file yielding no speech is `success: true` | `if (fail > 0) process.exitCode = 1`; `processFile` resolves empty-transcript results as `NoSpeechError` → `success: false, error: "no speech detected"` |
| `src/main.ts:4` | `parse()` + async actions → expected errors print raw stack traces | `createProgram().parseAsync()` with a `.catch` that prints one chalk-red line via `formatError` and sets `process.exitCode = 1` (re-throw `CommanderError` so `--help` exit codes stay intact) |

**Tests:**

- `cli.test.ts`: `setup` with a doctored failing check → `process.exitCode === 1`; `finalize --background` on a nonexistent dir → exit 1, no "started" line.
- `import.test.ts`: fake-whisper PATH stub returning an empty transcript → batch summary counts it failed, exit code 1.
- `main.test.ts` (new, thin): `parseAsync` error mapping — a rejecting command handler yields a one-line stderr message, not a stack.

---

## 6. Phase 4 — Swift fixes

### 6.1 Menu bar wedged in "Recording" by a dead attached session (P2-8)

`RecordingController.checkSessionState()` (`:390`) only checks whether the lock file exists. For an attached CLI session there is no `Process` to observe, so a `SIGKILL`ed node (or a closed terminal — no `SIGHUP` handler) leaves the lock on disk: the UI counts forever, Stop signals a dead PID, and manual Start is refused by `guard state == .idle` until relaunch.

**Fix:**

1. `ActiveLock.swift` gains `static func isPidAlive(_ pid: pid_t) -> Bool` (`kill(pid, 0) == 0`).
2. `checkSessionState()`: when `process == nil && attachedPid != nil` and the lock exists → if `!ActiveLock.isPidAlive(attachedPid!)` → `handleTermination()` + remove the stale lock file (same stale-cleanup path the CLI uses).
3. Extract the decision into a pure, testable function: `RecordingState.isAttachedSessionDead(lockExists: Bool, pidAlive: Bool) -> Bool` (no AppKit/EventKit imports, `CalendarMatch.swift` style).

**Tests:** new `--self-test-recording` flag in MeetMenuBar exercising the pure function (alive → keep counting; dead → terminate + clear; lock gone → idle); wired into `scripts/test-swift.sh` next to `--self-test-notch` / `--self-test-calendar`.

### 6.2 Writer error budget can never trip for write failures (P2-9)

`MicCapture.swift:296` resets `writerErrorCount = 0` after a successful `startChunk()` in the *recovery* path. Creating a 44-byte header proves only that file creation worked — the append/finalize failure that caused the error is unfixed. A persistent data-write failure cycles "append fails → reopen header → count reset", `writerFailed` stays false, the stream silently records nothing, and `CaptureRunner`'s all-streams-halted check never fires. Same logic in `SystemAudioCapture.swift:164`.

**Fix:**

1. Extract `WriterErrorBudget` into its own file (`native/AudioCapture/Sources/AudioCapture/WriterErrorBudget.swift`): `recordFailure()`, `recordSuccess()`, `var tripped: Bool`; consecutive-failure semantics; reset **only on a successful append+finalize**, never on `startChunk`.
2. Both captures call `recordSuccess()` in the append-success branch of the writer queue; the recovery path after `startChunk()` does *not* reset anything.
3. `CaptureRunner`'s halt check consumes `tripped` per stream.

**Tests:** AudioCapture grows a `--self-test-writer` flag running `assert()`-based checks on `WriterErrorBudget` (success-resets; failure-then-header-creation-does-NOT-reset is the regression case; threshold trip; cross-buffer consecutive counting). Wired into `scripts/test-swift.sh` (AudioCapture has no XCTest on Command Line Tools — the self-test flag follows the MenuBar pattern).

---

## 7. Phase 5 — P3 batch

Scheduled as a single follow-up PR (or two, split TS/Swift). Fix + test per row.

| # | Finding | Fix | Test |
|---|---------|-----|------|
| 1 | Final pass orders sys before mic at equal index; live/`entriesFromSession` put Me first (`filters.ts:127,183`) | Stable sort: same timestamp → mic first | `filters.test.ts`: same-index mic+sys → mic line first in filtered output |
| 2 | `extendCap()` turns `--max-duration 0` (unlimited) into ~15 min (`recorder.ts:747`) | `maxDurationMinutes === 0` stays 0; message says "unlimited" | `recorder.test.ts`: extend on unlimited → still 0 |
| 3 | Auto-extend sets fractional caps; `formatClock` prints `sec % 60` raw (`recorder.ts:912`, `auto-stop.ts:49`) | Round `newMaxDurationMinutes` with `Math.ceil`; `formatClock(Math.round(sec))` | `auto-stop.test.ts` + a `formatClock` unit case |
| 4 | `sys_missing` declared, never emitted (`capture-health.ts:5,91`) | Implement `checkSysMissing`: full mode, no finalized sys chunk for > N minutes while mic chunks flow → warning event | `capture-health.test.ts`: fixture stream with mic-only progress → event raised; mic-silent → not raised |
| 5 | `isPidAlive` accepts a recycled PID with a live `node` (`locks.ts:40`) | Store `pidStartTime` (`ps -o lstart= -p`) in lock payloads at acquire; `isPidAlive` compares when present; ps failure stays fail-open | `locks.test.ts`: PATH-stubbed `ps` returning mismatched start time → dead; matching → alive |
| 6 | JSONL records for chunks missing from `session.json` never become entries (`finalize.ts:235`, `assembler.ts:17`) | `entriesFromSession` iterates `processedChunks` ∪ stored-record keys | `finalize.test.ts`: JSONL-only chunk surfaces in the rewritten markdown |
| 7 | Torn JSONL append glues the next record to a torn line (`entries-store.ts:5,25`) | `appendEntryRecord`: read last byte, prepend `"\n"` when missing; read side keeps per-line skip + logs count | `entries-store.test.ts`: file without trailing newline → append → both records parse |
| 8 | Literal NUL bytes make `diarization-ab.ts` binary to git (`:44`) | Replace with `"\u0000"`; `file src/diarization-ab.ts` must say ASCII | Guard in `scripts/run-tests.mjs`: fail when any `src/*.ts` contains a NUL byte (meta-test, §2.1) |
| 9 | Progress-writer race: late `writeAtomic` can overwrite terminal `session.json` (`finalize.ts:62,1044`) | `dispose()` awaits the in-flight write promise before returning | `finalize.test.ts`: dispose during a pending write → final file is the `done` record |
| 10 | `speakers.json` write swallowed by `.catch(() => {})` (`finalize.ts:1012`) | `.catch(err => warn(...))` | `finalize.test.ts`: unwritable path (file-as-dir) → warning recorded, finalize continues |
| 11 | `speakers suggest` prints unquoted rename lines (`speakers-suggest.ts:75`) | Escape `"`/`\`/`` ` ``/`$` in the name, quote `meetingDir` | `speakers-suggest.test.ts`: names `Doe, John`, `A"b`, `` x`y `` → copy-paste-safe lines |
| 12 | `storage.test.ts` writes `meet-test-stale-*` into the real `~/.meet/sessions` | Add `setSessionsDirForTest` to `storage.ts` (mirror `locks.ts:15`); sandbox the suite | The suite itself; crash-before-`afterEach` no longer pollutes real state |
| 13 | Flaky time assertions: 5–30 ms sleeps (`summary-scheduler.test.ts:240`), `elapsed < 100 ms` (`final-pass.test.ts:96`) | Polling helpers (`awaitCondition(fn, timeoutMs)`); keep only generous hang bounds | Suites stabilize; CI on slower runners is the arbiter |
| 14 | Docs drift: README:82 "Queue tags" (actual: replace), README:86 `ask [question]` (actual `<sessionDir> <question>`), README:105 `--allow-degraded` (CLI never registers it — remove the row), AGENTS.md:92 "60min" (code: 75), AGENTS.md final-model wording (default is medium; turbo is opt-in), CLAUDE.md:319 "15s" (code: 30) | Apply the four-place docs-sync rule where a CLI surface changed | `cli.test.ts` command-signature check extended: README table's command list must match `createProgram()` commands (parse README between markers) |
| 15 | macOS floor: `LSMinimumSystemVersion` 13.0 vs required 14.2 for system capture (`Info.plist:12`) | Bump to 14.2; AGENTS.md notes the floor | Build check only (Info.plist) |
| 16 | Calendar: overlap losers resolved before the winner launches (`CalendarAutoStartController.swift:213`); failed spawn re-alerts every 20 s; `store.reset()` vs fetch race (`:143`) | Move `dropFirst()` resolution into the confirmed-launch branch; alert-once-per-occurrence flag; generation counter in the fetch queue | `--self-test-calendar` additions for the pure parts (CalendarMatch-level fixtures); controller parts reviewed manually |
| 17 | WAV writer: `abortCurrentChunk` leaves `carry` (`WAVWriter.swift:124`); tap can enqueue after `flushPartial` | Clear `carry` in abort; `isRunning` check *inside* the writer enqueue closure, and drain the queue after `flushPartial` | `--self-test-writer` cases for carry-clearing; concurrency case reviewed |
| 18 | Attendee names: declined/rooms kept, comma re-split corrupts "Doe, John" (`CalendarAutoStartController.swift:252`, `cli.ts:361`) | Filter by participation status + non-room; pass `attendees` as an array end-to-end (session.json → vocabulary extraTerms), drop the string re-split | `cli.test.ts` + CalendarMatch self-test fixture with a declined attendee and "Doe, John" |
| 19 | `Pipeline.start()` fire-and-forgets `rescan()`; watcher has no `error` listener (`pipeline.ts:87,99`) | `void this.rescan().catch(err => warn(...))`; `watcher.on("error", ...)` | `pipeline.test.ts`: readdir rejection → recorder survives |
| 20 | SIGUSR1/USR2 `void togglePause()` can become an unhandled rejection (`recorder.ts:720,813`) | `void this.togglePause(true).catch(err => this.warn(...))` | `recorder.test.ts`: rejecting pause path does not crash the process |
| 21 | `WavIO` ignores `fmt` sample rate/format tag; loads whole WAV into memory (~0.7 GB peak for 1 h concat) (`WavIO.swift:46`) | Read `fmt` fully (sample rate, format tag), reject/handle non-16 kHz explicitly; stream the `data` chunk in bounded windows | Split into its own task: acceptance = peak RSS < 200 MB transcribing a 1 h `sys-concat.wav`; a `--self-test-wavio` with a synthetic 48 kHz file asserting rejection |

---

## 8. Regression matrix & acceptance criteria

### 8.1 Matrix — every review finding maps to a named test

| Review item | Guarding test |
|---|---|
| P1-1 (CI/runner) | `scripts/run-tests.mjs` count guard; `test-runner.test.ts`; CI green run |
| P1-2 (page size, dead thresholds) | 4 tests in `system-monitor.test.ts` (§3.3) |
| P2-1 (cleanText) | 4 canary negative tests + hallucination positives (§4.1) |
| P2-2 (unreadable WAV) | 3 tests across `audio-metrics`/`final-pass`/`finalize` (§4.2) |
| P2-3 (echo gate vs textless sys) | 3 tests in `filters.test.ts` (§4.3) |
| P2-4 (all-dropped talk time) | 2 tests in `mic-echo`/`finalize` (§4.4) |
| P2-5 (startup race) | 3 tests in `recorder.test.ts` (§5.1) |
| P2-6 (Ctrl-D) | helper-driven close test (§5.2) |
| P2-7 (exit codes) | `cli`/`import`/`main` tests (§5.3) |
| P2-8 (wedged menu bar) | `--self-test-recording` (§6.1) |
| P2-9 (error budget) | `--self-test-writer` (§6.2) |
| P3 rows | per-row tests in §7 |

Rule going forward: **every review finding that lands as a code change must also land its test in the same commit**, and the commit message references the finding id (`P2-3`, `N1`, …).

### 8.2 Acceptance

1. `npm test` green on **Node 24 and Node 26** locally; ≥ 739 tests.
2. CI green on `master` on github.com — first green run since 2026-09-18 (verify with `gh run list --limit 3`).
3. `scripts/run-tests.mjs` proven to fail when `dist` contains no test files (manual: rename `dist`, run, observe exit 1, restore).
4. `git grep -P '\x00' src/` → empty; `file src/*.ts` reports text for every file.
5. The four docs-sync places agree for every command/flag touched here.
6. `npm run test:swift` green, including the new `--self-test-recording` and `--self-test-writer`.
7. Manual smoke: one live recording end-to-end with the final pass — talk-time footer totals equal the meeting length (no double count), `meet setup` exit code matches its message.
8. Optional real-world validation: re-finalize a backup copy of `~/Meetings/2026-10-30_15-33-meeting` and confirm the 915 s double-count shape is gone.

### 8.3 Non-goals

- Sentence-level echo dedup / sys-span subtraction (the review's real-world observation §"Real-world quality observation") — a separate spec; it is the largest remaining quality gap but not a correctness fix.
- SPEC_AGENT_CLI_2026-10-22 work — parallel track.
- Real-hardware testing of TCC/multi-process lock interleavings — out of reach for CI; covered by the manual smoke in §8.2.7.
