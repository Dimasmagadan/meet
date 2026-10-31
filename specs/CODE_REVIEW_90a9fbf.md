# Code Review: `90a9fbf` — last 2 commits

**Reviewed:** 2026-09-17
**Range:** `2bab056..90a9fbf` (`HEAD~2...HEAD`)
**Commits:**
- `2bab056 fix: implement 2026-09-16 code review findings`
- `90a9fbf docs(review): mark 2026-09-16 findings resolved`

Method: 8 finder angles run in parallel, candidates deduped, each verified by an independent 1-vote verifier (recall-biased).

---

## Confirmed

### `src/finalize.ts:135` — silent mic/sys reattribution masks real write failures

`filterStoredEntriesByAudio` silently reattributes an entry's source (mic↔sys) whenever its own-channel WAV is missing but the other channel's same-index WAV exists, without distinguishing a genuine write failure from the markdown-round-trip mislabel it targets.

**Failure scenario:** a genuine sys entry for chunk 5 whose `sys-005.wav` failed to write (crash/disk-full) in a full-mode session where `mic-005.wav` exists gets silently relabeled `source: "mic"` — wrong RMS threshold applied and wrong source persisted, corrupting downstream diarization/talk-time attribution with no warning logged.

### `src/talk-time.ts:66` — mic-echo chunks double-counted across two talk-time rows

When the mic channel is fully leaked to remote speakers (mic-echo attribution relabels every audible mic chunk), `computeTalkTime` falls back to `textChunkKeys`-based counting for "Me", which still counts those relabeled chunks toward "Me" seconds while the same duration is also summed into the remote speaker's row via `diarSegments`.

**Failure scenario:** a silent/no-headset participant whose every mic chunk gets voice-matched to a remote speaker (`mic-echo.ts`'s `runMicEchoAttributionStep` keeps `source: "mic"` but overrides speaker) results in double-counted talk-time seconds across two rows in the Talk Time footer, not just a cosmetic label mismatch.

### `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift:238` — inconsistent fail-open/closed on `ps` failure

`attachToExistingSession`'s `isNodeProcess` fails **closed** when `ps` can't be run (`processComm` returns nil), while `sendSignal`'s identical `ps`-failure case explicitly fails **open** by design in the same file.

**Failure scenario:** if `/bin/ps` can't be exec'd (sandbox/entitlement restriction, resource limits) while a `meet start` session launched from the CLI is genuinely recording, every menu-bar app launch refuses to attach and shows idle with no Pause/Stop/Extend, contradicting the sibling fail-open design intended for exactly this condition.

### `src/storage.test.ts:3010` — test mutates real `~/.meet/config.json` in place

The new "loadConfig mtime guard" test suite mutates the developer's real `~/.meet/config.json` in place (not an isolated temp fixture), relying on `afterEach` to restore it.

**Failure scenario:** if the test process aborts between the mutation and `afterEach` (crash, SIGKILL, OOM, forced test-runner exit), the developer's real `config.json` is left permanently mutated with test values (e.g. a test `outputDir`, `language: "ru"`), silently changing where `meet` writes recordings on the next run.

---

## Plausible

### `src/recording-state.ts:26` — capture PID check missing identity guard

The capture-process liveness check calls bare `isPidAlive(session.capturePid)` with no identity parameter, unlike every lock-owner PID check in this same diff, which was hardened to `isPidAlive(pid, { comm: "node" })` to close the PID-reuse hole.

**Failure scenario:** on a busy machine with PID reuse, a stale `capturePid` pointing at a dead AudioCapture process can get reused by an unrelated process; `classifyRecordingSessions` then misclassifies the session as "orphan" (capture supposedly alive) instead of "stale", and orphan-recovery logic could interact with the wrong process.

### `src/storage.ts:64` — missing `'error'` listener on background finalizer spawn

`spawnBackgroundFinalizer` spawns a detached child process with no `'error'` event listener, unlike the listener `recorder.ts` adds in this same diff for the identical async-spawn-failure bug class (ENOENT/EACCES surfacing as an `'error'` event, not a throw).

**Failure scenario:** if `process.execPath`/binPath is unresolvable in some environment when running `meet finalize --background`, the child's unhandled async `'error'` event crashes the parent CLI process with an uncaught exception immediately after `cli.ts` already printed a misleading "Background finalizer started (pid ...)" success message.

### `src/storage.ts:143` — invalid config defeats mtime cache

`loadConfig`'s new mtime cache only assigns `lastConfigMtimeMs` after `JSON.parse` succeeds, so an invalid `config.json` is never cached and every subsequent call re-parses from scratch.

**Failure scenario:** a user with a malformed `~/.meet/config.json` has `loadConfig` (called once per transcribed chunk during a live recording) redo the full `readFileSync` + `JSON.parse` + `sanitizeFileConfig` for the entire rest of the session, silently defeating the perf optimization the mtime guard was added for.

### `src/locks.ts:361` — registry lock release relies on implicit token match

`acquireRegistryLock`/`releaseRegistryLock` callers (`applySpeakerRegistry`, `runMicDiarizationStep`) call `releaseRegistryLock()` unconditionally in a `finally` block even on the early-return path where `acquireRegistryLock` returned false, relying on a module-global token match as an implicit safety net rather than an explicit "did I actually hold it" guard.

**Failure scenario:** currently safe because the two registry-lock operations run sequentially per process, but if a future change ever invokes two registry-lock-acquiring operations concurrently in the same process (e.g. batch-finalizing multiple sessions), the second operation's spurious finally-release could match the first operation's still-live token and unlink its lock out from under it mid-mutation.

### `src/finalize.ts:1866` — revert-to-live safety net depends on unenforced invariant

The finalize safety-net revert-to-live comparison trusts that `filters.ts`'s `droppedEcho` accumulator captures every path that drops a mic entry, but this invariant is enforced only by convention/comment, not by the type system.

**Failure scenario:** if a future edit to `filterEntries` adds a new continue/skip path that drops a mic entry without pushing to `droppedEcho`, the finalize safety-net comparison (`entries.length < effectiveBaseEntries.length`) would incorrectly trigger a revert-to-live, silently discarding legitimate final-pass entries.

### `src/talk-time.ts:27` — `textChunkKeys` silently optional

`computeTalkTime`'s new `textChunkKeys` parameter is optional with no type-level enforcement, and is only constructed/passed by `finalize.ts`'s single current call site.

**Failure scenario:** any future caller of `computeTalkTime` (e.g. an import-mode or batch talk-time feature) that omits `textChunkKeys` silently reverts to the old undercounting behavior for chunks whose text survived without an `entries.jsonl` record, with no type error or warning to catch the omission.

---

## Cut (cleanup, not bugs — noted for awareness)

- **`src/attention.ts`** — collapsed a per-alert-kind cooldown `Map` into a single scalar, removing the extension point documented for a future `"pause"` alert kind (confirmed, but no live bug today).
- **`src/locks.ts`** — a `{comm: "node"}` literal repeated at 5 call sites, and a third near-duplicate lock implementation (`acquireRegistryLock`/`releaseRegistryLock` copying `acquireGlobalFinalPassLock`'s token machinery almost verbatim) — real maintenance-risk cleanup, not a bug.
- **`isPidAlive`** now shells out to `ps` synchronously in `finalize.ts`'s poll loops, `status.ts` (3x redundant per session), and `RecordingController.swift` on every menu-bar action — verified real but not meaningfully impactful (`ps` is fast relative to poll intervals).
- **`cli.ts`/`finalize.ts`** registry-lock acquire/bail pattern repeated at 4 sites, with busy-message wording already drifted between the `cli.ts` pair and `finalize.ts` pair in this very diff — confirmed but low severity.
