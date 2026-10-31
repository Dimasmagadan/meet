# CI Linux findings — v1.2.0 release run (2026-10-31)

**Date:** 2026-10-31
**Status:** Documented, not fixed. The Node test gate moved to `macos-latest` (the product's only target platform) so the release gate works; the linux failures below are real and stay open as follow-ups.
**Evidence:** CI runs `41197501651` (CI) / `41197503827` (Release) — both cancelled after hanging ~25 min at "Run tests" on `ubuntu-latest`. Reproduced locally in `docker run node:24` against the same tree: same failures, same hang. Local darwin (Node 26 + Node 24.19): 808/808 green.

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
