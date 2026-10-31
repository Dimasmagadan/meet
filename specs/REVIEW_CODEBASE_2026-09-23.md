**Project review — 2026-09-23**

Deep review of the working tree at commit `c3a5b97` ("chore(release): v1.0.0"). Scope: the code that changed since the 2026-09-16 review (`2bab056`, `c2a51fa`, `373925d`, `6257166`), a fresh bug hunt over the finalize / talk-time / lock / recorder paths, the release tooling, the menu-bar controller, and the status of every earlier finding. The 2026-09-16 review and the untracked `specs/CODE_REVIEW_90a9fbf.md` were used as leads. No application code was changed as part of this review.

Validation baseline: `npm run lint` clean, `npm test` **724/724 pass across 147 suites** (~10.3 s). Runtime probes: (1) `computeTalkTime` against compiled `dist/` with a 4-chunk speakerphone fixture (N1); (2) `git cat-file -p v1.0.0` (N10); (3) a read-only look at the real `~/.meet/sessions/` on this machine, which surfaced N3 and N4 as things that already happen in practice, not just in theory.

Not exercised: real audio hardware, TCC, live Whisper/AudioAnalysis inference, and real multi-process lock interleavings.

---

## Status of earlier reviews

**`specs/CODE_REVIEW_90a9fbf.md` (untracked): fully resolved.** All four confirmed findings, all three plausible ones, and the three follow-ups were checked against current source. Mic-mode reattribution is now gated on `speakers.json` assignments (`finalize.ts:139-149`, `373925d`). `micSegmented` stops the full-leak double count (`talk-time.ts:75`). The menu-bar attach now fails open (`RecordingController.swift:245-247`). The config tests use `setConfigPathForTest` (`storage.test.ts:233`). The capture PID gets a comm guard (`storage.ts:330-331`). The finalizer spawn has an `'error'` listener plus an existence precheck (`storage.ts:64-81`). The mtime is cached before parsing (`storage.ts:185`). The registry lock has a depth counter (`locks.ts:337`). `textChunkKeys` is now required (`talk-time.ts:17`). The file can be deleted, or committed with a resolved marker.

**2026-09-16 review: its record needs three corrections.** The implementation annex describes fixes that are not what the code does:

- **B4 annex:** it says "the finalizer now drains the live queue before the final pass (`pipeline.stop()` semantics, not a second `close()`), and `runFinalPass` appends entry records". Neither is true. `finalize.ts:780-784` still calls `pipeline.close()` whenever the final pass will run, and `appendEntryRecord` still has exactly one call site (`pipeline.ts:284`). B4 was actually fixed by passing surviving-text keys into `computeTalkTime` (`textChunkKeys`, `finalize.ts:961`). The talk-time symptom is fixed, but by another route.
- **Architecture A2:** the annex says it was "folded into the B4 fix". It was not. `entries.jsonl` is still written only on the live path. **A2 is fully open.**
- **B11 annex:** it says `parseTranscriptEntries` changed. It did not: `assembler.ts:94` still maps every non-"Me" label to `sys`. The repair lives in `filterStoredEntriesByAudio` (`finalize.ts:139-149`). The fix is correct; the description is wrong.

**Architecture carry-overs:** A1 (13+ `session.json` writers: recorder ×11 mentions, finalize ×6), A2 (see above), A4 (`finalize.ts` has grown 984 → **1069** lines), A7 (`transcriber.ts:146-151` still re-reads and re-meters every WAV after `forEachAudibleChunk`/`pipeline.ts:224` already did), A11 (`speakers.json` write still `.catch(() => {})` at `finalize.ts:973`), A12 (`recorder.ts` 853 → **892** lines) and A6 (`import.ts:177,179` still stubs `mode: "full"`, `chunkDurationSeconds: 15`) all **remain as written**. The 2026-09-16 P3 about the mic-mode self voice getting labeled "Speaker N" is also still present.

---

## Bugs

### P2 — correctness

**N1. On calls without a headset, "Me" talk time counts the remote party's speech that leaked into the mic, so it is counted once as "Me" and again as "Speaker N". Reproduced.** Where: `talk-time.ts:44-47` (fallback path) and `mic-echo.ts:297` (segmented path), with the input built at `finalize.ts:954`.

Both "Me" derivations decide that a mic chunk was audible from its live `entries.jsonl` RMS. The live pipeline records an RMS for **every** mic chunk (`pipeline.ts:284`), including chunks the final pass then drops as echo (P1 coverage / P2 echoFraction / duplicate / ack → `droppedEchoKeys`). On a no-headset call those chunks are loud, so:
- (a) `activeChunkSeconds` unions them into "Me" through the RMS branch, even though their text did not survive.
- (b) when mic-echo attribution segmented the mic, `buildMicSegments` emits a "Me" span for them, because only this step's own `drops` are excluded, not the final pass's.

The same audio is also counted on the sys side under "Speaker N". **Probe:** 4 chunks; remote talks in 1-3 (echo-dropped on mic); the user talks only in 4. `computeTalkTime` returns **Me 120 s / Speaker 1 90 s** instead of Me 30 s. This is the B5 class again, reached through the P1/P2 filter drops instead of the mic-echo drops.

**Fix:** thread `droppedEchoKeys` into `computeTalkTime` and `runMicEchoAttributionStep`, and exclude those keys from the RMS set and from `buildMicSegments`. Add the probe above as a regression test.

**N2. The count-based safety net still discards the whole final pass for reasons that are not drops, and it can also hide real losses.** Where: `finalize.ts:900-908`, `final-pass.ts:221-230`.

`effectiveBaseEntries` excludes only `droppedEchoKeys`. The final pass also shrinks the entry count, with nothing recorded, whenever the final model **successfully** transcribes an audible chunk to empty text (a key in `completedKeys`, missing from `entries`) that the live model had text for. This is plausible because the live and final passes use different models *and* different decode thresholds (`types.ts:234-239`: entropy 2.4 vs 1.5, logprob −1.0 vs −1.5, no-speech 0.6 vs 0.7). One such chunk on a drained session (`s` path, or a live queue that kept up) sets `entries = effectiveBaseEntries`, which throws away the whole high-quality transcript for one mumble. That is the same symptom as B1.

The reverse also happens: on the default `q` path the undrained chunks exist only in the final pass. That inflates the final count, so several genuinely lost chunks can hide behind them and the net never fires.

The 90a9fbf review already flagged the "invariant enforced only by convention" risk; this is a concrete instance. By code reading, not reproduced.

**Fix:** compare per key instead of by count. For each base key that is missing from the final entries: skip it if it is in `droppedEchoKeys` or in `completedKeys` (the final pass succeeded and chose empty); otherwise restore **that one entry** from base.

### P3 — correctness, small

**N3. The debounced progress writer outlives finalize and leaks session directories. Seen on this machine: 8/8 leftover sessions.** Where: `finalize.ts:62-95`, unawaited `update()` at `:715` and `:872`, `rm` at `:1053`.

The Parakeet (and final-pass) progress callbacks call `progressWriter.update(...)` without `await`. Inside the 1 s window this schedules a `setTimeout` flush, and nothing cancels it. The flush can fire while `rm(sessionDir, {recursive, force})` is running. `writeAtomic` drops a tmp file into the directory being deleted, `rmdir` fails `ENOTEMPTY`, the `.catch(() => {})` swallows that, and the rename then lands a fresh `session.json`. **Evidence:** every one of the 8 `status: "done"` directories in `~/.meet/sessions/` holds only `session.json`, with `finalize.phase === "ab"`. The directory mtime equals the stale progress `updatedAt` plus <1 s (e.g. `meet-piZcEnwT`: 13:07:10.635Z → 16:07:11 local).

The same stale flush also writes `session.finalize` back to the old `"ab"` progress in memory (`flush` assigns `session.finalize = pendingProgress`), so it can clobber the `error` progress on the unrecovered-audio path.

The directories are filtered out as `done` (`recording-state.ts:16`), so the effect is clutter, not misclassification.

**Fix:** give the writer a `dispose()` that clears the timer, and call it (or `forceFlush`) before the terminal `session.json` writes.

**N4. Finalize can never succeed if the meeting's output folder is missing. Seen on this machine.** `meet-2GXf_ZYJ` ("СЕО викли", 2026-09-15, full mode, 214 WAVs preserved) has sat in `status: "error"` since 2026-09-15 12:58Z with `ENOENT … 2026-09-15_15-00-сео-викли/transcript.md.<pid>.<ts>.tmp`, and that folder does not exist. Nothing in finalize recreates `dirname(session.outputFile)`: `rewriteMarkdown` → `writeAtomic` fails, the whole finalize throws, and every retry fails the same way. Why the folder disappeared can't be determined from current state (possibly a retitle, or a manual delete; the session predates `2bab056`). The audio was preserved correctly, but the session can't be recovered without manual steps.

**Fix:** `mkdir(dirname(outputFile), { recursive: true })` at the start of the write phase. **Recovery now:** `mkdir -p ~/Meetings/2026-09-15_15-00-сео-викли && meet finalize ~/.meet/sessions/meet-2GXf_ZYJ`.

**N5. The recorder prints "Finalizer started" even when the spawn failed.** Where: `recorder.ts:482-483, 528-529, 552-553`.

`spawnBackgroundFinalizer` now returns `undefined` on a missing `execPath`/entry point (`storage.ts:68`). `c2a51fa` taught `cli.ts:91-96` to check that; the three recorder call sites (`q`/auto-stop, `s`, `n`) still ignore the return value and always print success. The user walks away believing a finalizer is running when the session is actually sitting unfinalized.

**N6. The session.json write at capture start is not awaited, so the surrounding try/catch cannot catch it.** Where: `recorder.ts:185`.

`startCapture()` is synchronous and calls `writeAtomic(...)` without `await`. A disk-full rejection therefore bypasses the `catch` that the comment at `:218-222` says handles exactly this case (kill the child, clear the lock). Instead it surfaces as an unhandled rejection, which crashes Node ≥15 with the capture child's fate left to SIGPIPE.

**Fix:** make `startCapture` async and await the write, or attach `.catch(err => this.handleCaptureStartFailure(err, captureProcess))`.

**N7. Finalize reads the speaker registry before taking the registry lock.** Where: `finalize.ts:418-419` and `:524-525`.

Both registry steps call `loadRegistry` and only then `acquireRegistryLock`, whereas `cli.ts:905-916` (forget), `cli.ts:998-1006` (enroll-self) and `speaker-rename.ts:146-155` all load *under* the lock. A `meet rename`/`forget` that commits between the two calls is overwritten by finalize's `saveRegistry` (lost update). The window is tiny because both calls are synchronous. The fix is a two-line swap.

**N8. The registry-lock tests use the real `~/.meet/sessions/registry.lock`, and `releaseAllRegistryLocks` can loop forever.** Where: `locks.test.ts:134-184`, `locks.ts:372-398`.

`locks.ts:8-11` hard-codes `homedir()`. The suite `writeFileSync`s fake owners over the real lock file. Running `npm test` while a finalizer or `meet rename` holds it clobbers a live lock, which is the same class as the config-file finding fixed in `c2a51fa`. A related defect in the helper: when `registryLockDepth === 1` and the lock file is gone or unreadable, `releaseRegistryLock` returns early **without** decrementing the depth, so `while (registryLockDepth > 0) releaseRegistryLock()` never terminates.

**Fix:** add a `setSessionsDirForTest` seam like `setConfigPathForTest`, and reset the depth to 0 on the not-ours/unreadable path.

**N9. [Swift] `pause()`/`resume()` overwrite the idle state that `sendSignal` just set.** Where: `RecordingController.swift:94-104` with `:274-285`.

`sendSignal` calls `handleTermination()` when it detects PID reuse. That sets `state = .idle`, clears `attachedPid` and stops both timers. `pause()` then sets `state = .paused` unconditionally (and `resume()` sets `.recording`). With the monitors stopped and `terminationHandled == true`, nothing ever resets the state. The UI stays stuck in Paused, and `start()` refuses (`guard state == .idle`) until the app is relaunched. This needs PID reuse to trigger, so it is rare.

**Fix:** have `sendSignal` return `Bool` and only change state when it returns true.

**N10. Release tag messages lose their headings.** Where: `scripts/release.mjs:172`.

`git tag -a -m <section>` uses the default `--cleanup=strip`, which deletes every `#`-prefixed line. The `v1.0.0` tag message has no `## [1.0.0]` / `### Added` / `### Fixed` headings, so Added and Fixed items run together (verified with `git cat-file -p v1.0.0`). The GitHub Release body is unaffected because `release.yml` reads `CHANGELOG.md`.

**Fix:** pass `--cleanup=verbatim`.

---

## Swift — additional notes

- The B3 control-queue serialization holds: every engine mutation now goes through `controlQueue` (`MicCapture.swift:69,129,179,288,361`), and the writer-failure teardown correctly hops from `writerQueue` to `controlQueue`.
- Some flags are still shared across threads without synchronization: `writerFailed` (written on `writerQueue`, read on `controlQueue` and in the main loop), `lastBufferTime` (written on the real-time tap thread, read on `controlQueue`) and `paused` (written from the signal queue, read on the real-time thread). On arm64 these are single-word values, so the race is benign in practice, but Thread Sanitizer would flag it. Low priority.
- `sendSignal` spawns `/bin/ps` synchronously on the main thread for every Pause/Resume/Stop/Extend (`RecordingController.swift:293-311`), adding a small UI hitch on each action. The 2026-09-16 P3 about `waitUntilExit()` on the main thread in `setTags`/`retitle`/`ask` is still present too.

## Test coverage and engineering practices

**Facts:** 44 non-test modules, 38 test files, 19,571 TS lines. 724 tests / 147 suites / 0 failures. CI has 3 workflows (`ci.yml`, `pages.yml`, `release.yml`).

- **Gaps still open from 2026-09-16:** `Recorder` class tests; fake whisper-cli/ffmpeg binaries; `parakeet-pass.ts`/`opencode.ts`; real Swift unit tests. N5 and N6 would have been caught by a `Recorder` test with a stubbed spawn.
- **`finalizeSession` is still never called end-to-end by tests.** N2 and N3 both live in the orchestration layer. A test with a fake `AudioAnalysis`/whisper and `parakeetComparePass: true` that asserts the session directory is gone afterwards would pin N3.
- **N1 regression test:** add the 4-chunk speakerphone fixture above to `talk-time.test.ts`.
- **Test isolation:** after `c2a51fa` the config tests are sandboxed, but `locks.test.ts` still touches `~/.meet/sessions` (N8). A shared `HOME`-redirect helper would close the whole class.

## AI-slop pass (small)

- `finalize.ts:1030`: `const [source, index] = key.split("-")`. `index` is never used; `tsconfig.json` has no `noUnusedLocals`, which is why it compiles silently.
- `readRecoveredSources` (`finalize.ts:169-194`) inserts every assignment under up to three aliases (canonical, as-recorded, display) to paper over the fact that mic-echo stores **display** names in `entryAssignments` (`mic-echo.ts:258`) while sys diarization stores **canonical** ones (`finalize.ts:363-365`). A single convention (canonical everywhere, display via `speakerNames`) would remove the alias fan-out. It would also fix `meet rename`'s validation, which matches `entryAssignments[].speaker` literally (`speaker-rename.ts:61`).
- The 2026-09-16 annex misstatements above (B4/A2/B11) are the review-process version of the same problem: a summary written from intent rather than from the diff. Future annexes should cite the changed lines.

---

## Suggested implementation order

1. **N4 recovery (user action, now):** recreate the missing folder and re-run `meet finalize` for `meet-2GXf_ZYJ`. The audio is intact. Then add the `mkdir` fix.
2. **N1:** talk-time double count on every no-headset call. The change is small and the probe doubles as the test.
3. **N2:** per-key safety net. It is the last way a whole final pass can still be thrown away.
4. **N3 + N5 + N6:** finalize/recorder lifecycle hygiene. Each is a few lines; add one `finalizeSession` orchestration test.
5. **N7 + N8:** lock ordering and test isolation.
6. **N9, N10,** the slop items, and deleting the leftover `done` session directories (safe: they hold only `session.json`).
7. **Carry-overs A2/A4/A12:** unchanged recommendation from 2026-09-16. `finalize.ts` has grown another 85 lines since then.
