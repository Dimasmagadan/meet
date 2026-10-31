# CI Linux findings — v1.2.0 release run (2026-10-31)

**Date:** 2026-10-31
**Status:** Documented, not fixed. The Node test gate moved to `macos-latest` (the product's only target platform) so the release gate works; the linux failures below are real and stay open as follow-ups.
**Evidence:** CI runs `41197501651` (CI) / `41197503827` (Release) — both cancelled after hanging ~25 min at "Run tests" on `ubuntu-latest`. Reproduced locally in `docker run node:24` against the same tree: same failures, same hang. Local darwin (Node 26 + Node 24.19): 808/808 green.

---

## 1. What happened

The v1.2.0 tag push triggered CI + Release. Both hung indefinitely at `npm test` on `ubuntu-latest`. The suite did not fail — one test file never finished, so `node --test` waited forever, and the job has no timeout (GitHub default is 6h).

## 2. The hang: `recorder.test.js` never drains on linux

`node --test` runs each file in a child process; the file's process ends only when its event loop drains. On linux, two P2-5 tests inside `src/recorder.test.ts` fail their assertions and **abandon a live `Recorder.run()`**:

- `capture exiting during startCapture triggers shutdown (P2-5)` — `exitCalls[0]` is `1` (the catch path), expected `0`.
- `a real capture binary exiting at spawn settles run() (P2-5 fake-binary variant)` — same `1 !== 0`.

The failures throw out of the test, leaving `runPromise` pending. That `run()` instance still owns its 5s status interval (and the active-recording lock), so the file process never exits → the runner waits forever. On darwin both tests pass, so the same leak never materializes. The file-level error confirms it: `Promise resolution is still pending but the event loop has already resolved`.

**Under the assertion failure:** on linux, capture-exit during `startCapture` lands in `run()`'s catch (`Failed: ENOENT: rename '/tmp/meet-recorder-meeting-*/meta.md.256.*.tmp' -> meta.md` → `process.exit(1)`), while darwin takes the graceful path (`process.exit(0)`). Timing-dependent race (the spawn-to-listener gap vs. the meta.md write); the ENOENT itself still needs a root cause.

## 3. Linux test failures (18, across 3 clusters)

1. **recorder (2)** — see §2.
2. **locks/storage pid-identity (7)** — `isPidAlive`, `acquireFinalizerLock`, `readFinalizerLock`, `prevents duplicate lock acquisition`, `findStaleSessions`, `excludes finalizing sessions with a live lock`, `returns active lock when pid is alive`, `confirms the process identity when the comm matches (B9)`. These exercise `ps -o comm=` / `ps -o lstart=` identity semantics (`locks.ts` B9) whose output/behavior differs under procps on linux.
3. **system-monitor (5+)** — `getSystemPressure` (+ heavy-child attribution) and the threshold tests exercise real `sysctl`/`vm_stat` probes (macOS-only binaries; empty output on linux → assertions on parsed values fail).

The `ci.yml` claim "no macOS APIs" (`ubuntu-latest` job comment) is therefore false as of this tree — the suite drifted back onto darwin behavior after the safety-net refactor.

## 4. Decision

- CI `Lint + build + test (Node)` and the Release workflow moved to `macos-latest`. The tool is macOS (Apple Silicon) only; the gate should run where the product runs. The macOS Swift job was already green.
- The linux findings above are the follow-up backlog: either make the suite genuinely platform-independent (mock the ps/comm + sysctl probes, root-cause the recorder race) or keep the darwin-only gate permanently. Do not re-enable `ubuntu-latest` for the Node job without fixing §2 — it will hang again.
- Worth fixing regardless of platform: the recorder race (§2) is a real behavior difference in shutdown exit codes, and the suite has no per-file hang bound — a single leaking test file can wedge CI for 6h. A run-level timeout in `scripts/run-tests.mjs` (kill + fail loudly) would convert any future hang into a red run with output.
