# SDD Spec: Codebase Reliability and Recovery Hardening

**Date:** 2026-08-21
**Status:** Draft
**Owner:** Dmitrii Diakonov
**Source review:** `specs/REVIEW_CODEBASE_2026-08-21.md`

---

## 1. Problem

Meet's normal recording/finalization path is reliable, but several failure
paths can hide recoverable meetings, block future recordings, or silently stop
one audio stream:

1. A hard-crashed Node controller leaves `session.status = "recording"`, which
   is excluded from stale-session and status reporting.
2. The Swift capture child can outlive Node, so absence of the controller lock
   does not prove the session is safe to finalize.
3. Active-lock metadata is published and refreshed non-atomically. Partial JSON
   can block recording, while eager malformed-file deletion can violate mutual
   exclusion.
4. WAV I/O/finalization errors leave ambiguous writer state and are only logged.
5. System capture stops retrying after one failed restart.
6. Invalid CLI/config values can disable safety caps or prevent chunk creation.
7. Speaker-registry matching accepts malformed biometric vectors, is assignment
   order dependent, and does not enforce private storage modes.

This SDD defines a phased reliability pass. It does not add user-facing product
features or change transcript format.

## 2. Goals

- Never treat a live orphan Swift capture as a finalizable stale session.
- Never allow a new recording while a known live orphan capture exists.
- Preserve exclusive active-recording ownership without exposing partial lock
  metadata.
- Recover from transient writer failures when safe, or fail a stream visibly
  instead of silently recording nothing.
- Keep retrying recoverable system-tap startup failures with bounded backoff.
- Reject invalid CLI values before creating session/output artifacts.
- Reject dangerous config values while preserving last-known-good hot reload.
- Make speaker identity matching dimension-safe, deterministic, and private on
  disk.
- Add automated coverage around every changed failure path.

## 3. Non-goals

- No cloud recovery or upload.
- No automatic killing of an orphan PID without verifying ownership.
- No new `meet recover` command; existing `meet finalize` remains the recovery
  action for sessions proven inactive.
- No broad lock-system rewrite for finalizer/global locks unless a shared helper
  is required by the active-lock implementation.
- No rewrite of Phrasebook/Triggers/Vocabulary into a generic hot-reload engine.
- No filename migration for existing `mic-NNN.wav` / `sys-NNN.wav` chunks.
- No promise of power-loss durability beyond explicitly implemented fsync
  behavior.
- No speaker-registry data migration beyond validation/quarantine of malformed
  entries.

## 4. Design principles and invariants

### 4.1 Recording ownership

At most one recording controller or orphan capture may be active globally.

For each persisted `status === "recording"` session:

- **active** means a live active lock exists and its `sessionDir` matches;
- **orphan** means no matching live controller lock exists and the persisted
  `capturePid` is alive;
- **stale** means neither a matching controller nor capture is alive;
- a lock for a newer session must not hide an older orphan/stale session.

Only stale sessions may be advertised as directly finalizable.

### 4.2 Lock publication

- A reader must see either no active lock or complete valid metadata.
- Exclusive acquisition must remain a single filesystem ownership operation.
- Metadata refresh must never create a parse-failure window.
- A process may clean up its own failed publication immediately.
- Release remains owner checked.

### 4.3 WAV writer state

The writer is always in one explicit state:

- `idle`: no open chunk;
- `writing`: a writable temporary chunk exists;
- `failed`: the current chunk is unusable and must be reset/reopened or the
  stream must terminate.

After an I/O error, appending must not silently return as if data was accepted.
A `.wav` name is emitted only after header finalization and successful rename.

### 4.4 Capture health

Audio callback health and storage health are independent:

- `lastBufferTime` tracks incoming audio callbacks;
- `lastSuccessfulWriteTime` tracks durable writer progress;
- restarting Core Audio does not count as a remedy for ENOSPC or filesystem
  permission failures.

### 4.5 Biometric data

- Registry vectors are exactly the supported backend dimension (currently 256)
  and contain only finite numbers.
- Similarity of unequal dimensions is invalid, not a truncated comparison.
- One meeting label and one registry identity form at most one assignment each.
- Private registry state remains private across atomic replacement.

## 5. Phase 1: Recording recovery and active-lock protocol

### 5.1 Shared recording classification

Add a pure classification helper, expected in `src/status.ts` or a focused new
module such as `src/recording-state.ts`:

```ts
type RecordingState =
  | { kind: "active"; session: Session; lock: ActiveRecordingLock }
  | { kind: "orphan"; session: Session; capturePid: number }
  | { kind: "stale"; session: Session };
```

Inputs:

- persisted sessions;
- one snapshot of the active lock;
- injectable PID-liveness predicate for tests.

Rules:

1. Match active ownership by normalized `sessionDir`, not merely by the
   presence of any live lock.
2. A valid live `capturePid` without a matching controller is orphaned.
3. Null, invalid, or dead `capturePid` without a controller is stale.
4. A live lock whose session JSON is temporarily absent remains active for
   start exclusion but is reported as incomplete metadata.

`findStaleSessions()` must use this classification or be replaced by an API
that returns all three states. Avoid repeated lock reads with cleanup side
effects during one scan.

### 5.2 Status and start behavior

`meet status` adds an `Orphaned capture` section containing:

- session path and title;
- capture PID;
- explicit stop instruction;
- finalization instruction that is only safe after the capture exits.

`meet start` behavior:

1. If an active controller exists, retain the current message.
2. If any orphan capture exists, refuse to start and print its PID/session.
3. If stale sessions exist, warn and continue, retaining current behavior.

The implementation must not automatically signal an orphan PID solely because
the integer is alive. PID reuse remains possible. A future ownership check may
compare the process executable before offering an automated stop.

### 5.3 Complete-before-visible lock publication

Replace `openSync(lockPath, "wx")` followed by writing visible metadata with a
complete-before-visible protocol.

Recommended file-based design:

1. Create a unique temporary file in `~/.meet/sessions/` with mode `0600`.
2. Write the complete JSON, close it in `finally`, and optionally fsync it.
3. Publish ownership using an atomic exclusive operation that fails if
   `active-recording.lock` already exists. On local APFS, a hard link from the
   complete temporary inode to the lock path satisfies this contract.
4. Remove the temporary name after publish or failure.
5. Refresh owned metadata by writing a complete temporary file and atomically
   renaming it over the existing lock after verifying current ownership.

An exclusive lock directory with metadata inside it is an acceptable
alternative, but it changes the on-disk contract consumed by the menu bar and
requires a coordinated Swift migration. Prefer retaining the current lock-file
path.

Malformed lock behavior after this protocol lands:

- retry a read once to tolerate a concurrently replaced inode;
- if still malformed, reclaim it as legacy/corrupt metadata;
- acquisition then retries exactly once;
- never unlink a valid lock owned by another live PID;
- cleanup paths must close descriptors even when writes fail.

### 5.4 Concurrent-start artifact cleanup

Keep collision-safe output reservation before authoritative lock acquisition.
If acquisition loses the race, remove only artifacts uniquely created by that
process:

- the new session directory, which has no shared owner;
- the reserved meeting directory, provided it still contains only the header
  this process created.

Do not move acquisition before output reservation without introducing a formal
provisional-lock state; lock consumers currently expect usable paths.

### 5.5 Phase 1 acceptance criteria

- Dead Node + dead capture appears as recoverable stale and is offered for
  `meet finalize`.
- Dead Node + live capture appears as orphan, blocks a new start, and is not
  offered as immediately finalizable.
- A new active lock for session B does not hide stale/orphan session A.
- Readers never observe partial metadata produced by the new publication path.
- A failed creator write leaves no permanent lock.
- A malformed legacy lock is reclaimed without allowing two owners.
- Two concurrent acquisitions produce exactly one success.
- Losing a start race leaves no header-only output or empty session directory.

## 6. Phase 2: Swift writer and stream resilience

### 6.1 Explicit `WAVWriter` failure transition

Refactor `WAVWriter` so failure cleanup is one operation rather than scattered
field mutation. Expected API shape:

```swift
mutating func abortCurrentChunk(preserveTemporary: Bool)
mutating func startChunk() throws
mutating func appendSamplesIfNeeded(_ samples: [Int16]) throws -> Bool
mutating func finalizeChunk() throws -> String?
```

Requirements:

- `startChunk()` throws if file creation fails; do not rely on
  `createFile(...)`'s ignored Boolean.
- append without an open writable chunk throws an explicit writer error.
- finalization always closes best-effort and leaves no closed non-nil handle.
- successful state reset happens only after rename succeeds.
- failed temporary audio is preserved under a diagnostic/quarantine name when
  it may contain useful PCM; otherwise it may be removed to recover disk space.
- destination removal must not delete a valid finalized chunk before its
  replacement is known to be publishable. Chunk names should normally be
  unique, so an existing destination is an error worth surfacing.

### 6.2 Storage-failure policy

Mic and system capture share the same policy:

1. On first write/finalize/open failure, emit structured JSON
   `stream_write_failed` including source and error.
2. Abort/reset the failed writer state.
3. Retry opening a fresh chunk with bounded backoff while audio callbacks
   continue to be discarded explicitly.
4. Emit `stream_write_recovered` when durable writes resume.
5. After a bounded failure interval, emit `stream_failed` and propagate failure
   to `CaptureRunner`; do not continue an apparently healthy session forever.

Exact retry defaults:

- initial retry delay: 1 second;
- maximum retry delay: 10 seconds;
- fatal threshold: 30 seconds without a successful write.

These constants may remain internal; no config keys are required initially.

`lastBufferTime` remains callback health. Add `lastSuccessfulWriteTime` or an
equivalent writer-health state. Do not restart the audio engine/tap for pure
storage failures.

### 6.3 System-tap restart state

Replace overloaded `isRunning` semantics with at least:

- `shouldRun`: true after start until explicit stop;
- `isRunning`: current Core Audio tap/device state;
- `isRestarting`: reentrancy guard.

On restart failure:

- teardown every partially created tap, aggregate device, and IOProc;
- keep `shouldRun = true`;
- retry with bounded backoff;
- stop retrying after explicit pause/stop as appropriate;
- emit structured restart-failed/recovered events.

### 6.4 Pause silence baseline

Replace direct pause-Boolean mutation with transition methods or equivalent
edge detection. On resume, set `lastVoiceTime` to the resume time so the user
receives a full silence interval before auto-stop can fire.

### 6.5 Swift test target

Add a test target to `native/AudioCapture/Package.swift`. Extract pure or
injectable seams where required; do not mock Core Audio APIs globally.

Required tests:

- rename failure leaves no zombie handle/full counter state;
- ENOSPC during append/header/open follows reset and retry policy;
- successful retry creates a later finalized chunk;
- persistent storage failure reaches fatal state;
- first system restart fails and a later retry succeeds;
- partial Core Audio startup resources are torn down;
- stop cancels restart retries;
- post-pause silence timeout starts from resume;
- channel extraction covers interleaved/non-interleaved fixtures;
- resampler covers 48k, 44.1k, 16k, and 8k input across split buffers.

### 6.6 Phase 2 acceptance criteria

- A transient rename/open failure does not silently kill the stream.
- Persistent ENOSPC produces a visible fatal capture result within the bounded
  interval.
- Audio callbacks cannot make a failed writer appear healthy.
- System capture retries after its first failed restart and can recover.
- Pausing longer than the silence timeout does not stop immediately on resume.
- Existing 16 kHz mono WAV/chunk naming contracts remain unchanged.

## 7. Phase 3: CLI and configuration validation

### 7.1 Strict CLI parsers

Add reusable Commander parsers that throw `InvalidArgumentError`.

Integer duration rules:

- reject empty, fractional, prefixed (`2junk`), non-finite, and unsafe values;
- reject negatives;
- allow zero only where zero explicitly means disabled;
- validate before creating session/output artifacts.

Apply to:

- `start --silence`;
- `start --max-duration`;
- `start --no-text-timeout`;
- `speakers enroll-self --seconds`.

Use explicit choices for:

- `doctor [target]`: `mic | full`;
- `transcribe --model`: `small | medium`.

### 7.2 Semantic config validation

Extend `sanitizeFileConfig()` with a per-key validator map. Preserve current
last-known-good behavior: invalid fields warn once and fall back rather than
crashing live hot reload.

Minimum constraints:

- `chunkDurationSeconds`: positive safe integer;
- max/no-text durations: finite and non-negative;
- polling, timeout, budget, and count fields: documented positive/non-negative
  integer ranges;
- overlap/probability/cosine thresholds: documented bounded ranges;
- `outputDir`, binary paths, required model paths, and language: non-empty where
  empty has no intentional meaning.

Validate final effective start options as well, because CLI overrides bypass
file sanitation.

### 7.3 Path normalization and guarded cleanup

- Expand literal `~` at all CLI session-path boundaries.
- Resolve paths before active-lock equality comparisons.
- Replace guarded `process.exit(1)` calls with `process.exitCode = 1; return`
  where a `finally` must run.
- Do not globally replace exits with thrown async errors until `main.ts` uses
  `parseAsync()` with a top-level rejection handler.

### 7.4 Phase 3 acceptance criteria

- Invalid numeric/choice input exits through Commander before creating files.
- `--max-duration abc`, `2junk`, `-1`, and fractional input are rejected.
- Configured zero/negative chunk duration falls back with one warning.
- Quoted `~/...` and relative active-session paths resolve correctly.
- Enrollment failures remove their temporary directory.

## 8. Phase 4: Speaker identity correctness and privacy

### 8.1 Embedding validation

Define the AudioAnalysis embedding dimension as a named constant, currently
256. Validate at parse, registry load, registration, and matching boundaries:

- exact length;
- every element is a finite number;
- non-zero norm where cosine matching requires it.

`cosineSimilarity()` must reject unequal lengths by returning 0 or a typed
failure. It must never compare only the shorter prefix.

Malformed persisted entries are skipped with a visible warning count. Preserve
the original corrupt registry for diagnosis instead of silently overwriting it.

### 8.2 Score-ordered one-to-one assignment

For all meeting labels and eligible registry speakers:

1. compute candidate pairs at or above threshold;
2. sort by descending cosine score;
3. apply deterministic secondary keys for exact ties: canonical label order,
   then registry ID;
4. greedily accept a pair only if neither side is assigned;
5. register unmatched meeting labels after assignment is complete.

Talk time is not part of identity confidence and must not be used as a hidden
tie-break unless a future product requirement explicitly introduces it.

### 8.3 Private storage

Implement a private atomic writer rather than applying `chmod` after save:

- `~/.meet/speakers/`: `0700`;
- registry temporary and final file: `0600`;
- `matches.log`: create/enforce `0600`;
- replacement must retain these modes under ordinary `022` umask.

Cross-session IDs in output `speakers.json` are shareable-data leakage. Preferred
design:

- keep matching metadata in a private per-meeting state under `~/.meet`;
- write only display labels/names and meeting-local speaker IDs to the output
  directory.

If moving metadata would break an existing CLI workflow, retain it temporarily
but document the exposure and split the migration into a follow-up. The file
permission fix is not blocked by this decision.

### 8.4 Phase 4 acceptance criteria

- 255/257-dimensional, NaN, Infinity, string-element, and zero vectors cannot
  participate in matching.
- A later stronger candidate receives the identity instead of an earlier weaker
  candidate.
- Exact-score ties are deterministic across map/JSON order.
- Two meeting labels never receive one global identity in the same run.
- Registry and log modes remain private after multiple atomic saves.
- Corrupt registry input is preserved/quarantined and visibly reported.

## 9. Phase 5: Text and deterministic cleanup

### 9.1 Unicode word boundaries

Replace literal phrasebook `\b` wrapping with Unicode-aware lookarounds:

```regex
(?<![\p{L}\p{N}_])LITERAL(?![\p{L}\p{N}_])
```

Compile with the `u` flag and preserve `i`/`g` behavior. Raw-regex mode keeps
its current contract. Repair the affected `к <date/day>` alternatives in
`ACTION_ITEM_REGEX` without placing boundaries around intentionally stem-like
cues.

### 9.2 Small deterministic fixes

- Round total talk-time seconds before deriving minutes/remainder.
- Define equal-overlap diarization tie order by overlap, earlier segment start,
  then canonical speaker number.
- Make `relabelSegments()` preserve already canonical input or narrow its
  documented precondition and reject mixed input.
- Replace literal source NUL bytes with `"\u0000"` or a structured map.
- Trim slug separators after truncation and use `meeting` if empty.
- Handle SIGHUP through the normal shutdown path in both Node and Swift.
- Include `phrasebookAllowRegex` in cache invalidation.

### 9.3 Phase 5 acceptance criteria

- Cyrillic standalone words match phrasebook boundary rules but substrings do
  not.
- `59.6` seconds renders `1m 0s`.
- Equal-overlap assignments are unchanged when input JSON order is reversed.
- Unsupported-script-only titles produce a non-empty output directory name.
- SIGHUP finalizes the current partial WAV and initiates Node shutdown.

## 10. External-process seam tests

Add fixture executables that pass through the real `execFile`/spawn paths
without requiring installed models:

- capture argv to a file;
- emit controlled stdout/stderr;
- create expected output files;
- sleep to exercise timeout behavior;
- return configurable non-zero exit codes.

Cover whisper, AudioAnalysis, ffmpeg, and QoS wrapping. Keep real-binary smoke
tests environment gated; CI must not download models.

## 11. Expected files

| Phase | Expected files |
|---|---|
| 1 | `src/locks.ts`, `src/storage.ts`, `src/status.ts`, `src/cli.ts`, optional `src/recording-state.ts`, corresponding tests |
| 2 | `WAVWriter.swift`, `MicCapture.swift`, `SystemAudioCapture.swift`, `main.swift`, `Package.swift`, new Swift tests |
| 3 | `src/cli.ts`, `src/storage.ts`, CLI/storage tests |
| 4 | `src/speaker-registry.ts`, `src/finalize.ts`, registry/finalize tests, optional private registry-state module |
| 5 | `src/phrasebook.ts`, `src/summary.ts`, `src/talk-time.ts`, `src/diarization.ts`, `src/diarization-ab.ts`, `src/recorder.ts`, Swift `main.swift`, tests |
| Process seam | transcriber/import/diarization process wrappers and fixture scripts/tests |

## 12. Sequencing and delivery

1. **PR 1 - lifecycle and lock protocol.** No Swift changes. This establishes
   safe ownership/recovery semantics before any automatic recovery work.
2. **PR 2 - Swift writer and restart state.** Add Swift tests first, then change
   writer/retry behavior.
3. **PR 3 - CLI/config validation and cleanup.** Independent after PR 1's start
   cleanup behavior is stable.
4. **PR 4 - registry correctness/privacy.** Keep biometric behavior changes in
   one auditable PR.
5. **PR 5 - Unicode and low-risk deterministic fixes.** Small, independently
   reviewable commits are acceptable.
6. **PR 6 - external-process fixture tests.** Can run in parallel after process
   wrapper APIs settle.

Do not combine broad hot-reload/helper deduplication with these PRs. Reliability
diffs should remain behavior-focused and easy to audit.

## 13. Verification

Each phase:

```bash
npm run lint
npm run build
npm test
./native/AudioCapture/scripts/build.sh
```

Run Swift tests through the package command introduced in Phase 2.

Manual gates:

1. Start a recording, SIGKILL only Node, verify the surviving capture is shown
   as orphan and blocks another start.
2. Stop that capture, verify the same session becomes recoverable stale and can
   be finalized.
3. Run two concurrent starts; exactly one records and the loser leaves no
   output artifact.
4. Inject a temporary writer rename/open failure; verify a structured warning
   and either recovery or explicit stream failure, never silent success.
5. Force one system-tap restart failure; verify a later retry succeeds.
6. Under a `022` umask, save the registry twice and inspect `0700`/`0600` modes.

## 14. Rollback and compatibility

- Session JSON remains backward compatible; `capturePid` already exists.
- Active-lock JSON fields and path remain compatible with MenuBar readers.
- New status categories change display only.
- Existing malformed registry entries are skipped/quarantined, not migrated
  into fabricated vectors.
- Existing chunk names and transcript markdown remain unchanged.
- If lock publication fails on an unsupported filesystem, fail closed with a
  clear error rather than falling back to a partial-visible lock.

## 15. Risks and open decisions

- **Orphan PID ownership:** PID liveness alone can match a reused PID. Initial
  implementation reports/blocks but does not kill automatically. Process-path
  verification can be added later.
- **Exclusive publication primitive:** hard-link publication preserves the file
  contract on local APFS. Confirm behavior on the supported macOS filesystem;
  fail closed elsewhere.
- **Writer retry data loss:** audio received while storage is unavailable cannot
  be buffered indefinitely. The bounded retry policy favors honest failure over
  unbounded RAM use or silent loss.
- **Registry output migration:** removing global IDs from `speakers.json` may
  affect `meet speakers suggest` or rename workflows. Trace consumers before
  choosing the private per-meeting state format.
- **Swift testability:** Core Audio construction is difficult to unit test.
  Extract state/backoff decisions from API calls rather than building a broad
  mock framework.
