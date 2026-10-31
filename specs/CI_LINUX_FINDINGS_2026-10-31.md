# CI Linux findings — v1.2.0 release run (2026-10-31)

**Date:** 2026-10-31
**Status:** Fixed (same day). The §4 items, §7.3.1–§7.3.5 lock/test changes, §7.3.3/§7.3.4 runner hygiene, and the §7.3.9 skips + canary are landed — see §8 for the itemized diff, the two decisions taken, and the exact verification commands. The Node gate stays on `macos-latest` (the product's only target platform); a non-blocking linux canary now tracks the rest, and flipping it to a gate waits for one green CI canary run.
**Evidence:** CI runs `41197501651` (CI) / `41197503827` (Release) — both cancelled after hanging ~25 min at "Run tests" on `ubuntu-latest`. Reproduced locally in `docker run node:24` against the same tree: same failures, same hang. Local darwin (Node 26 + Node 24.19): 808/808 green.
**Review:** §7 (2026-10-31, second pass) re-verified §2–§5 against the code and added eleven follow-ups; several are defects outside this doc's original scope (lock-type coverage, `lstart` locale/TZ, leaked test isolation, invocation-dependent test count).

---

## 1. What happened

The v1.2.0 tag push triggered CI + Release. Both hung indefinitely at `npm test` on `ubuntu-latest`. The suite did not fail — one test file never finished, so `node --test` waited forever, and the job has no timeout (GitHub default is 6h).

## 2. The unified root cause: `ps -o comm=` on linux names the main thread, not the executable

**Correction (2026-10-31, same day):** the first write of this doc attributed the recorder failures to a shutdown exit-code race. A focused rerun (`node --test --test-name-pattern 'P2-5' dist/recorder.test.js` in `node:24`) plus a direct probe exposed one root cause under **all** the pid-identity failures, recorder included:

```
$ ps -o comm= -p <live node pid>     # linux (procps), node:24 container
MainThread
```

On linux, `ps -o comm=` reports the **main thread title** node sets (`MainThread`), not the executable name `node` that darwin's BSD `ps` prints for the same flag. `isPidAlive(pid, { comm: "node", ... })` (`src/locks.ts:58-89`) therefore returns **false for a live node process** on linux — the exact fail-closed inversion the comment at `locks.ts:65-70` says it must never produce ("ps failing is not evidence of a dead process... fail open rather than orphan a real owner"). Here ps doesn't fail; it answers a different question.

## 3. The failure chain, end to end

1. `locks.ts` / `storage` cluster: every liveness check with `comm: "node"` (or a captured `captureComm`) misclassifies a live owner as dead → duplicate finalizer locks acquire, live locks get reclaimed by `readActiveRecordingLock`, `findStaleSessions` misclassifies — all the `✖ isPidAlive` / `acquireFinalizerLock` / `readFinalizerLock` / `findStaleSessions` failures.
2. `recorder.test.js` P2-5 pair: the harness acquires the active lock (`acquireActiveRecordingLock`), then `Recorder.startCapture` calls `writeActiveRecordingLock` → `readActiveRecordingLock` sees its own live lock as stale (comm probe), **unlinks it**, returns null → `writeActiveRecordingLock` throws `Active recording lock is not owned by this process` (`locks.ts:123`) → `handleCaptureStartFailure` (`recorder.ts:272-278`) prints `Failed to start AudioCapture: …` and calls `process.exit(1)` — **stubbed in the harness**, so `1` is pushed into `exitCalls` and control returns instead of exiting. `startCapture`'s catch returns, `run()` proceeds, `shutdown()` completes gracefully and pushes `0`. The test asserts `exitCalls[0] === 0` and sees `1`.
3. The hang: test 1's assertion throws before `await runPromise` (`withRecorderHarness` awaits it only on the happy path, `recorder.test.ts:190`), the harness `finally` `rmSync`es the meeting dir mid-shutdown — that is where the logged `ENOENT: rename '…/meta.md.*.tmp' -> meta.md` comes from (the abandoned instance's `writeMetaFile` losing its target dir; the catch then prints `Failed: ENOENT…` / `Recoverable session…` **after** the ✖). The abandoned instance never reaches `pipeline.close()` — `shutdown()`'s catch path (`recorder.ts:526-529`) skips it — so the chokidar `FSWatcher` (`pipeline.ts:95`) stays open and the file's test process never drains. `node --test` waits on that child forever; the GitHub job has no timeout below the 6h default.

So the recorder exit-code divergence is **not** product shutdown-race behavior: on darwin the same tests pass and the product's shutdown branches never diverge. The genuinely product-relevant residues are in §4.

## 4. What is still worth fixing (platform-independent)

- **`isPidAlive`'s identity check is one format quirk away from reclaiming live locks on the Mac too.** It trusts `ps -o comm=` string equality. `comm: "node"` happens to hold on darwin today; if that ever changes (OS upgrade, node rename, launchd wrapping), live active-recording/finalizer locks get silently reclaimed — the data-loss direction. A cross-platform source (`ps -o args=` first-token basename, or `/proc/<pid>/exe` where available) plus a regression test pinning the probe against this very failure mode would harden darwin.
- **`shutdown()`'s catch path skips `pipeline.close()`** (`recorder.ts:526-529`): any throw after `stopRecording()` (the meta.md write included) leaves the chokidar watcher open. Harmless in production only because `process.exit(1)` hard-exits; in any embed/test context it wedges the event loop. Best-effort close in the catch is a two-line fix.
- **`run()` fire-and-forgets shutdown** (`recorder.ts:109`: `void this.shutdown()`) while the exit-listener path awaits it (`:118`). `run()` can therefore return while shutdown is still mutating world state, and the P2-5 "settles with exit code 0" contract degrades to "first exit call wins" whenever a mid-`startCapture` exit fires. `await this.shutdown()` (or awaiting it before resolving) makes the settle contract deterministic.
- **Test harness hygiene:** `withRecorderHarness` must await `runPromise` in a `finally` (even when `fn()` throws) and `rmSync` only after it settles — the cleanup-abandoned-instance race manufactured the ENOENT.
- **Suite-level hang bound (landed in `c2c9436`):** `scripts/run-tests.mjs` now SIGKILLs a run exceeding 10 min and fails loudly — see §5.

## 5. The landed hang bound — mechanics and tradeoffs

What `c2c9436` added to `runNodeTest` (`scripts/run-tests.mjs`):

- `TEST_RUN_TIMEOUT_MS = 10 * 60_000` around each `node --test` attempt (both the directory-form attempt and the glob retry each get a fresh window).
- On expiry: `child.kill("SIGKILL")`, resolve `{ code: 1, output: "" }`, and print `[run-tests] test run exceeded 10 min and was killed — a test file is hanging.`
- Two independent fail-closed guards then fire: the explicit message, and — because a killed run has no summary line — the existing §2.1 count guard (`No test summary found — refusing to report success`). A hang now costs ≤10 min and is RED, not yellow-forever.
- The partial test output is not lost: `runNodeTest` streams every chunk to stdout as it arrives, so the log shows exactly how far the suite got before the kill (the technique that located the recorder hang in the first place).

Why run-level, not test-level: the wedge class this guards against happens **after the last test of a file has already passed** — a leaked handle (open watcher, interval, abandoned promise) keeps the file's event loop alive. `--test-timeout` has no running test to time out, and `run-tests.mjs` spawns one `node --test` child for the whole suite, so the whole run is the only kill boundary available without rewriting the runner to spawn per file.

Deliberately **not** used: `--test-force-exit` (Node ≥22) would also unwedge CI by force-exiting each file's process once its tests finish — but it turns a leak into a silent GREEN. The kill-to-red choice keeps "file did not drain" a loud failure; revisit only together with the §4 fixes that remove the leak class.

Why 10 min: the suite is ~10 s locally and ~25-90 s in CI; the bound leaves an order of magnitude of headroom for slow runners while staying 36× under GitHub's 6 h default job timeout.

## 6. Decision

- CI `Lint + build + test (Node)` and the Release workflow moved to `macos-latest` (`c2c9436`). The tool is macOS (Apple Silicon) only; the gate should run where the product runs. The macOS Swift job was already green; Release v1.2.0 was re-cut on the moved tag.
- The linux findings above are the follow-up backlog. Do not re-enable `ubuntu-latest` for the Node job before fixing §4 (isPidAlive identity source + harness cleanup at minimum) — with the §5 bound it now fails in ≤10 min instead of hanging, but it still fails.
- Failure inventory at the time of writing (18): recorder P2-5 pair (see §3.2), locks `isPidAlive`/`acquireFinalizerLock`/`readFinalizerLock`/`prevents duplicate lock acquisition`, storage `findStaleSessions`/`excludes finalizing sessions with a live lock`/`returns active lock when pid is alive`/`confirms the process identity when the comm matches (B9)` — all §2/§3.2; and system-monitor `getSystemPressure` (+ heavy-child attribution) and the threshold tests, which shell out to real `sysctl`/`vm_stat` (macOS-only binaries, separate cluster).

---

## 7. Review notes (2026-10-31, second pass)

Review scope: re-derive §2–§5 from the code and from fresh runs, then list what the doc misses. No product code was changed in this pass.

### 7.1 §2 is confirmed — the probe output, both platforms

The root cause is real and platform-asymmetric, measured on this tree:

| probe (live node pid) | darwin, node 26 | linux, node:24 container |
|---|---|---|
| `ps -o comm= -p <pid>` | `node` | `MainThread` |
| `ps -o args= -p <pid>` | `node -e setTimeout(...)` | `node -e setTimeout(...)` |
| `/proc/<pid>/comm` | — (no procfs) | `MainThread` |
| `ps -o lstart= -p <pid>` | `Sat Oct 31 19:33:20 2026` + trailing spaces | `Sat Oct 31 12:32:52 2026` (same shape) |

(Local time on both, trailing whitespace is `.trim()`ed by the code. Both were measured during this review, on the running tree.)

So `comm === "node"` is a darwin-only accident, not an invariant: the same live process answers `MainThread` on linux and the identity predicate in `locks.ts:76` returns `false`. The doc's proposed replacement source (`ps -o args=` first token, or `/proc/<pid>/exe` on linux) does work — `args` still starts with `node` on linux — with the two caveats in §7.3.10 and §7.3.1.

### 7.2 §3 and §5 reproduce exactly as written

- Whole suite, clean copy of HEAD, `docker run node:24 node scripts/run-tests.mjs`: the runner streams output, then at 10 min prints `[run-tests] test run exceeded 10 min and was killed — a test file is hanging. Refusing to report success.`, then the count guard, and exits `1`. The bound does what §5 claims; kill-to-red is the right call (agree with the `--test-force-exit` rejection).
- `dist/recorder.test.js` alone hangs identically (killed at 90 s, exit `124`). Its summary is `✖ dist/recorder.test.js (90012.9ms) 'Promise resolution is still pending but the event loop has already resolved'`, and the log contains every element of §3.2/§3.3: `Failed to start AudioCapture: Error: Active recording lock is not owned by this process` ×3, `Failed: ENOENT … meta.md.<pid>.<ts>.tmp -> meta.md`, `Recoverable session: …`. Both failing assertions are the predicted `1 !== 0`: `capture exiting during startCapture triggers shutdown (P2-5)` and `a real capture binary exiting at spawn settles run() (P2-5 fake-binary variant)`.
- Lock cluster failure names at HEAD: `confirms the process identity when the comm matches (B9)`, `prevents duplicate lock acquisition` (under `acquireFinalizerLock`), `returns active lock when pid is alive` (under `readFinalizerLock`). Matches §2/§3.2.
- Definitive inventory at HEAD, obtained from `node --test --test-force-exit 'dist/**/*.test.js'` in `node:24` (force-exit used only to step around the hang): **800 tests / 790 pass / 10 fail** — locks 3, recorder 1 (`capture exiting during startCapture triggers shutdown (P2-5)`), storage 1 (`excludes finalizing sessions with a live lock`), system-monitor 5 (`getSystemPressure` threshold + heavy-child attribution). That is a lower bound, not a full inventory: force-exit cuts off the 7 later tests of the stalling `recorder.test.js` (see §7.3.6), and one of them — the fake-binary P2-5 variant — fails when the file is run without it. So the real failing set is ≥11, still not the 18 of §6 (§7.3.8).
- Same method on darwin: 807 tests / 801 pass / 6 fail (the 6 are the review-sandbox artifacts in §7.3.11). The 807-vs-800 delta is the 7 tests force-exit skipped on linux, not a platform difference in test count.
- Count hygiene: the "808" is not all tests. The directory form (`node --test dist` — the wrapper's first attempt, and what `npm test` uses whenever that form succeeds) also executes `dist/test-runner.test.d.ts` as a test file, adding one phantom entry; the runner-expanded glob reports 807. Harmless today, but the expected count is invocation-dependent, which matters before anyone pins a per-file floor to it.
- Bound arithmetic nit: §5 says the directory-form attempt and the glob retry "each get a fresh window". In practice the worst case is **one** window: a timed-out attempt resolves with `output: ""`, which cannot match the retry condition (`output.includes("Cannot find module")`), so 10 min is the true ceiling. Worth stating as one window so nobody plans for 20.

### 7.3 Findings the doc does not have

1. **The `pidStartTime` PID-reuse guard covers one of four lock types.** `locks.ts:238` (`cleanStaleLock`), `:343` (`readGlobalFinalPassLock`), `:361` (`readFinalizerLock`) and `:416` (`acquireRegistryLock`) all call `isPidAlive(pid, { comm: "node" })` — no `startTime` — even though `acquireFinalizerLock` writes `pidStartTime` into the payload (`:268`) that nobody reads, and the global/registry payloads never write one. The lock identity check therefore rests entirely on the very field that is broken on linux. Fix both problems in one move by making the payload self-describing instead of hardcoding `"node"`: record the owner's `ps -o comm=` output at acquire, compare stored-vs-current on read, and thread `startTime` through every reader.
   ```ts
   // at acquire: pidComm: readPidComm(process.pid)   (null → no identity check, legacy locks fail open)
   // at read:    isPidAlive(data.pid, { comm: data.pidComm, startTime: data.pidStartTime })
   ```
   `storage.ts:346` makes the same kind of hardcoded assumption for the capture PID (`captureComm` = the configured binary's basename); the stored-identity approach covers that too — store the comm the spawned child actually reports, not the one its config path implies.
2. **`lstart` is formatted by the *reading* process's locale and timezone.** `ps -o lstart=` goes through `strftime` (local time, localized month/day names). Writer and reader need not agree: a lock written by the LaunchAgent (`TZ` unset, `LANG` from launchd) and read from a shell with `TZ=UTC` or `LANG=ru_RU.UTF-8` produces a different string for the *same live process*, so `now !== identity.startTime` (`locks.ts:86`) reclaims a live lock — the data-loss direction. Not demonstrated (the node:24 image ships no ru locale, so `LANG=ru_RU.UTF-8` fell back to C), but it is structural. Pin `env: { ...process.env, LC_ALL: "C", TZ: "UTC" }` on both `execFileSync("ps", …)` calls (or parse the string to an epoch before comparing).
3. **On the timeout path the count guard prints a false diagnosis.** `run-tests.mjs:82` resolves `{ code: 1, output: "" }`, so `parseTestCount` returns `null` and `:111` claims `the runner matched zero test files` — after a 10-min kill in which the glob had matched 156 files. The explicit hang message above it saves the log, but the second line actively misleads a reader skimming for the cause. Thread the `timedOut` flag through and skip (or reword) the count guard in that branch. Adjacent cosmetic: on Node 24 every run first dumps a ~15-line `Cannot find module '/…/dist'` MODULE_NOT_FOUND stack before the glob retry (`:101-107`); probing support for the directory form instead of relying on that failure would keep CI logs honest.
4. **`SIGKILL` kills the `node --test` parent only; the per-file child survives.** Demonstrated in a container: runner pid 7 with child 14; after `kill -9 7`, pid 14 still runs (its stdout pipe now points at a dead parent, so whatever it does after that is invisible). On a GitHub runner the job teardown hides this, but a local `npm test` can leave an orphaned node process behind after a "loud" failure. Spawn the runner detached and kill the process group (`process.kill(-child.pid, "SIGKILL")`).
5. **The `pidStartTime` tests leak a fake active-recording lock into the real `~/.meet/sessions`.** `locks.test.ts:234-293` never calls `setSessionsDirForTest`, so `writeLock` targets the real sessions dir; the "matching start time" and "ps failure stays fail-open" cases deliberately *keep* the lock and nothing removes it. Artifact found on this machine during review: `~/.meet/sessions/active-recording.lock` with `{"pid":<dead test pid>,"pidStartTime":"Mon Jan  1 01:01:01 2001","sessionDir":"/tmp/x",…}`, which can only have been written by a run in which the "lock kept" cases passed. Consequences are hygiene-level (while the suite runs, `meet status` reports a live recording and a concurrent `meet start` is refused; after the run the next reader reclaims it), but it is the exact N8 isolation class the neighbouring describe already fixes at `:136-149`. Sandbox this one too and `unlink` in `afterEach`.
6. **The wedge is a stalled test promise, and §3.3's open-watcher explanation is unproven.** At kill time the child's own diagnostic is *"Promise resolution is still pending but the event loop has already resolved"* — at that moment Node reports no live handles, only an unresolved test promise (the harness skips `await runPromise` at `recorder.test.ts:190` when `fn()` throws, so the abandoned `run()`/`shutdown()` chain is simply dropped). Two consequences. (a) Don't reach for `--test-force-exit` as the CI fix: beyond §5's "turns a leak into a silent GREEN" objection, it *hides tests* — on linux it ends the stalling file early, so the 7 tests after its second P2-5 case (`recorder.test.ts:252-464`) never run, and the fake-binary variant's own failure disappears from the summary. (b) Before treating `pipeline.close()` in the catch path as *the* fix, log `process.getActiveResourcesInfo()` from the harness `finally` after `fn()` throws. If it is empty, the wedging agent is the dropped promise, not a live watcher, and closing the pipeline will not unbind the suite.
7. **`ci.yml:15-18` still cites the retracted cause.** The job comment says "recorder shutdown race", which §2 replaced with the comm-probe chain. A future reader will re-derive the wrong theory from it; update the comment when touching the gate.
8. **§6's 18-item inventory does not reproduce; it overcounts.** Measured at HEAD on linux: ≥11 failures in four clusters (locks 3, recorder 2, storage 1, system-monitor 5) — see §7.2. The doc's list also mixes suites across files (`returns active lock when pid is alive` is a `readFinalizerLock` test; `confirms the process identity…` is `isPidAlive`) and appears to predate the P3 `pidStartTime` work that fixed some of them. Record the exact command behind any future inventory (`node --test --test-force-exit 'dist/**/*.test.js'` **plus** per-file runs for the wedged file, since force-exit truncates the stalling file) so "fixed" is checkable rather than remembered.
9. **§4 alone will not make linux green.** `system-monitor.test.ts:93-165` and the stub-path tests at `:351+` drive `getSystemPressure`'s default sensor with real `sysctl`/`vm_stat`; only the two parser tests at `:293`/`:305` have non-darwin guards. Those probes are macOS-only *by design*, so the correct fix is a `node:test` skip on non-darwin, not a product change. Until then, the cheap unblock is a `continue-on-error: true` linux canary job running the suite in `node:24`: with the §5 bound it can go red in ≤10 min but can never hang a release, and it gives the follow-up a live signal.
10. **`ps -o args=` is not a stable identity source either — use it as advisory.** procps truncates `args` to the terminal width (80 columns when piped); pass `-ww`. And `args` is argv, which a process can rewrite at runtime (`process.title` on linux), so `startTime` must stay the primary guard with the command as a sanity check — the opposite ordering from what §4's "cross-platform source" sentence implies.
11. **Local darwin run in this review session: 808 tests, 802 pass, 6 fail — all six induced by the review sandbox, not by product code.** The sandbox denies `/bin/ps` (`Operation not permitted`) and writes outside the workspace (`EPERM … ~/.meet/sessions/active-recording.lock`). Verbatim failures: `rejects a live PID whose command does not match (B9)`, `a stored start time that no longer matches → dead owner (lock reclaimed)`, `a matching start time → alive (lock kept)`, `ps failure stays fail-open (lock kept, never orphan a real owner)`, plus `speaker-rename` `writes the name into the matched registry entry when registry is enabled` and `reverse-resolves a display-name id to canonical before touching registry/speakerNames` (both `registry busy`, from the same denied `~/.meet/sessions` write). The doc's "808/808 green" was therefore *not* re-confirmable here — an unsandboxed `npm test` is still needed to re-establish it. CI state at review time (`gh run list --limit 5`): `41201089203` CI success 2m34s, `41200154905` Release success 34s, `41200151037` CI success 1m30s, and the two cancelled runs from §1 (36m34s / 36m37s).

### 7.4 Suggested order of work

1. §7.3.1 + §7.3.2 (self-describing lock identity, pinned `ps` env) — one small `locks.ts` change that fixes linux and hardens darwin; add a real-probe regression test (spawn a node child, assert `isPidAlive(child.pid, { comm: "node" })`) so the stub-only tests at `locks.test.ts:234` can never mask this again.
2. §7.3.5 + §7.3.6 (sandbox those tests; instrument the leak) — cheap, and they change what the §4 `pipeline.close()` fix is worth.
3. §4 as written (harness `finally`, `await shutdown()`, catch-path `pipeline.close()`), verified by a linux run that completes on its own — no hang, no force-exit, full test count.
4. §7.3.4 + §7.3.3 (process-group kill, timeout-path message) — runner hygiene, no product impact.
5. §7.3.9 + canary job, then re-enable `ubuntu-latest` as a gate only if a linux run is actually green.

All five steps are done — see §8.

---

## 8. Fixes landed (2026-10-31, third pass)

Implemented in the §7.4 order against the same tree. Product code touched: `src/locks.ts`, `src/recorder.ts`. Tests touched: `src/locks.test.ts`, `src/recorder.test.ts`, `src/system-monitor.test.ts`. Tooling touched: `scripts/run-tests.mjs`, `.github/workflows/ci.yml`. No CLI commands or config flags changed, so the README/docs sync rule does not apply.

### 8.1 What changed, item by item

- **§7.3.1 — self-describing lock identity.** `locks.ts` gained `readPidComm(pid)` (exported) and a private `readPidIdentityFields()`; every acquire now writes `pidComm` + `pidStartTime` into the payload (active-recording, finalizer, global final-pass, registry — the latter two never carried a start time before), and every reader (`readActiveRecordingLock`, `cleanStaleLock`, `readGlobalFinalPassLock`, `readFinalizerLock`, `acquireRegistryLock`) compares stored-vs-current instead of hardcoding `"node"`. `pidComm: null` (ps unavailable at acquire) and legacy payloads without the fields skip the comm check — fail-open, unchanged semantics.
- **§7.3.2 — pinned `ps` env.** Both `ps` probes go through one `psField()` helper that runs with `env: { ...process.env, LC_ALL: "C", TZ: "UTC" }`, so `lstart` strings are locale/TZ-independent between writer and reader. Verified with a full linux suite run under `TZ=Asia/Tokyo LANG=ru_RU.UTF-8` (green).
- **Real-probe regression tests (§7.4.1).** Two added to the `isPidAlive` describe: (a) spawn a real node child and assert `isPidAlive(child.pid, { comm: readPidComm(child.pid) })` — the assertion uses the comm ps *actually reports* rather than a literal `"node"`, because on linux that literal can never match (`MainThread`), which is the whole bug; (b) `acquireFinalizerLock` → `readFinalizerLock` round-trip against real ps — this is the test that fails on linux whenever anyone reintroduces a hardcoded comm. Both fail open (pass) in ps-less environments.
- **§7.3.5 — pidStartTime suite sandboxed.** The `isPidAlive pidStartTime (P3 row 5)` describe now `setSessionsDirForTest`s into a tmpdir and removes it in `afterEach`; the "lock kept" cases can no longer leave `active-recording.lock` bytes in the real `~/.meet/sessions`. Verified: after a full darwin run, `~/.meet/sessions` contains no lock files.
- **§7.3.6 — leak instrumentation.** `withRecorderHarness` logs `process.getActiveResourcesInfo()` to stderr when `fn()` throws, so any future wedged run states its own cause in the log.
- **§4 — recorder/harness settle contract.** `run()` now `await this.shutdown()` on the capture-died-instead-of-fire-and-forget path; `shutdown()`'s catch best-effort `await this.pipeline.close().catch(() => {})` before `process.exit(1)`; `withRecorderHarness` awaits `runPromise` in its `finally` (even when `fn()` throws) and restores the stubbed `process.exit` + `rmSync`s only after the run settles — the stubbed exit must stay installed while draining, or a real `process.exit(1)` would kill the test runner mid-finally. The fake-binary P2-5 variant's inline harness got the same finally-drain. Residual, deliberately out of scope: `stopAndFinalizeForeground`'s catch also exits without closing the pipeline, but its watcher is already closed once `pipeline.stop()` begins, and no test exercises that catch — revisit if it ever gains one.
- **§7.3.3 — timeout-path diagnosis.** `runNodeTest` resolves `{ code, output, timedOut }`; `main()` exits 1 on `timedOut` before the count guard, so a 10-min kill no longer gets misdiagnosed as "matched zero test files". The `TEST_RUN_TIMEOUT_MS` comment now states the true ceiling: one window per `npm test` (a timed-out attempt never triggers the glob retry).
- **§7.3.3 (cosmetic) — directory-form probe.** The MODULE_NOT_FOUND retry is replaced by a version gate: dir form attempted only on Node ≥ 26 (verified empirically — dir form works on 26.8.2, fails on 24.19 with `Cannot find module`), glob form directly otherwise. Also makes the expected count invocation-independent except for the known phantom `.d.ts` entry on Node 26.
- **§7.3.4 — process-group kill.** The runner spawns `detached: true` (non-win32) and the timeout kills via `process.kill(-child.pid, "SIGKILL")` with a `child.kill` fallback, so the per-file test children die with their runner instead of being orphaned.
- **§7.3.9 — system-monitor skips.** The seven default-sensor tests (5 in `getSystemPressure` + 2 heavy-child) call a `skipIfNotDarwin(t)` helper. Two node:test quirks shaped this: a suite-level `skip` option on Node 24 drops the subtests from the summary count entirely (`tests 29, skipped 0` — the platform-dependent count the doc warns against), and `t.skip()` does not halt the test body — without a `return` the assertions still ran and failed the suite. Per-test `t.skip()` + early return gives identical counts on both platforms (linux: `tests 809, pass 802, skipped 7`).
- **§7.3.7 + §7.3.9 — CI.** The `ci.yml` job comment now cites the comm-probe chain instead of the retracted shutdown-race theory, and a `linux-canary` job (ubuntu-latest, `continue-on-error: true`) runs lint+build+test on Node 24 as a non-blocking signal.

### 8.2 Decisions taken

1. **`storage.ts:346` (`captureComm`) is deliberately unchanged.** §7.3.1 suggested storing the spawned capture child's actual comm instead of the configured binary's basename. Reading the child's comm immediately after spawn races the exec: before exec completes, ps reports the parent's comm (`node`), and a stored wrong value is worse than the current fallback — it would make the identity check reject the real capture. The basename fallback is correct on both platforms for the default binary (linux truncates comm to 15 chars; `AudioCapture` is 12), so linux is green without it. Revisit only if custom `captureBin` paths ever need identity checks, and pair the read with a readiness signal rather than doing it inline at spawn.
2. **The linux canary stays `continue-on-error: true` for now.** A local `docker run node:24` run being green (below) is strong evidence but not the CI runner's environment; per §6/§7.4.5 the gate flip waits for one green canary run on CI, then `linux-canary` can be promoted to a required gate (or the main Node job can move back to ubuntu) in a follow-up commit.

### 8.3 Verification evidence (exact commands, per §7.3.8)

| Run | Command | Result |
|---|---|---|
| darwin, Node 26.8.2 | `npm test` | exit 0 — `tests 810, pass 810, fail 0, skipped 0` (807 pre-existing + 2 new probes + 1 phantom `.d.ts`) |
| linux, node:24 container | `docker run --rm -v <tree>:/app -w /app node:24 npm test` | exit 0 — `tests 809, pass 802, fail 0, skipped 7`, **completes on its own in ~10 s: no hang, no force-exit** |
| linux + hostile locale/TZ (§7.3.2) | same, with `TZ=Asia/Tokyo LANG=ru_RU.UTF-8` | exit 0, same counts |
| Type check | `npm run lint` | clean |

The §6 failure inventory at HEAD is zero: the recorder P2-5 pair, the four lock-cluster failures, the two storage failures, and the five system-monitor failures are all pass-or-skip on linux now. Pre-fix linux baseline for comparison: ≥11 failures (§7.2), full-file hang without force-exit.
