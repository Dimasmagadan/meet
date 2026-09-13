# Codebase Review — 2026-08-21

Full-project review: Node orchestration (`src/`), Swift capture
(`native/AudioCapture/`), tests, and privacy posture. Findings were revalidated
against source after the initial review. Implementation requirements live in
`specs/SPEC_CODEBASE_RELIABILITY_2026-08-21.md`.

## Overall

The project is well engineered: atomic transcript/session writes, exclusive
locks, exact chunk splitting, a phase-carrying downsampler, contract-focused
tests, and fail-open optional passes. Most findings are failure-path robustness
or latent correctness defects rather than architectural flaws.

The original review identified the right problem areas, but overstated several
severities and proposed unsafe fixes for active-session recovery and malformed
locks. The corrected disposition follows.

## P0 operational correctness

### 1. Hard-crashed recording controllers are absent from recovery surfaces

**Location:** `src/storage.ts:180-201`, `src/status.ts:8-87`,
`src/recorder.ts:159-169`

**Verdict:** confirmed; P0 operational priority, High severity.

`findStaleSessions()` excludes every `status === "recording"` session. A
SIGKILL'd Node controller leaves that state unchanged, while
`readActiveRecordingLock()` removes the dead controller's lock. `meet status`
then has no bucket for the persisted recording and can report that nothing is
active.

The original fix, "recording + no active lock means stale", is unsafe. The
Swift child can survive its Node parent: `session.capturePid` may still be live
and writing WAV files after the controller lock disappears. Finalizing that
session can race the writer; allowing another start can run two captures.

**Required fix:** classify persisted recording sessions as:

1. active controller: a live lock matches the session directory;
2. orphan capture: no matching controller lock, but `capturePid` is alive;
3. recoverable stale: neither controller nor capture is alive.

Surface orphan captures in `meet status`, block a new recording while one is
alive, and only advertise `meet finalize` for recoverable stale sessions.

### 2. Malformed active-lock metadata can permanently block recording

**Location:** `src/locks.ts:39-65`, `src/locks.ts:86-96`

**Verdict:** confirmed; High availability severity.

The active lock is visible immediately after `openSync(..., "wx")`, before its
JSON is completely written. A crash in that window leaves empty or partial
metadata. Parsing returns `null` without removing the file, but the acquisition
retry still receives `EEXIST` forever.

The original fix, "unlink whenever JSON parsing fails", is unsafe. A status
reader can observe a legitimate lock while it is still being written and
unlink it, after which a second process can acquire ownership. In-place refresh
through `writeActiveRecordingLock()` has the same partial-read window.

**Required fix:** publish complete lock metadata atomically while preserving
exclusive acquisition, update owned metadata by atomic replacement, and clean
up the creator's failed publication. Once partial metadata can no longer be
published, malformed legacy locks can be reclaimed safely.

### 3. WAV finalization failure leaves an unusable writer state

**Location:**
`native/AudioCapture/Sources/AudioCapture/WAVWriter.swift:84-105`

**Verdict:** confirmed; High stream-availability severity, not Critical.

If header finalization, close, destination handling, or rename fails, writer
state is not transitioned consistently. A closed handle may remain non-nil;
for a full chunk, `currentDataSize` also remains at capacity, so later appends
can return before any recovery is attempted.

The original fix, "nil the handle in `defer`", is incomplete: a nil handle plus
a full `currentDataSize` and no opened successor chunk is still wedged.

**Required fix:** define an explicit writer failure transition that closes
best-effort, resets the in-memory state, preserves or quarantines the failed
temporary file, and either reopens a new chunk or reports a fatal stream error.

## High priority

| Issue | Verdict and correction | Location |
|---|---|---|
| Persistent disk-write failures can silently stop durable chunk production while audio callbacks continue | Confirmed, High. Track storage health separately from callback health; reset/retry or fail the stream explicitly. Changing only `lastBufferTime` would trigger pointless audio restarts. | `MicCapture.swift:147-199`, `SystemAudioCapture.swift:130-170` |
| System capture stops retrying after one failed restart | Confirmed, High. Separate "capture desired" from "tap currently running" and clean partial Core Audio resources between retries. | `SystemAudioCapture.swift:203-249` |
| Invalid CLI numeric values disable safety limits or fail Swift argument parsing | Confirmed, High for unattended sessions. Bare `parseInt` accepts prefixes, negatives, and `NaN`; nullish coalescing does not replace `NaN`. | `cli.ts:44-46`, `cli.ts:360-364` |
| Semantically invalid configuration reaches capture/finalization | Confirmed. `chunkDurationSeconds <= 0` is High because it prevents normal chunks; most other range failures are Medium. `outputDir: ""` normally fails startup rather than reliably writing relative paths. | `storage.ts:47-65` |

## Medium priority

| Issue | Verdict and correction | Location |
|---|---|---|
| Concurrent-start loser leaves an empty session directory and header-only meeting directory | Confirmed, Medium. It pollutes `meet list`; dashboard normally ignores it because no `meta.md` exists. Clean only the directories reserved by the losing process rather than acquiring a provisional lock before paths exist. | `cli.ts:276-337` |
| Phrasebook `wordBoundary` uses ASCII `\b`, so Cyrillic literal rules do not match normal words | Confirmed, Medium. Port Unicode letter/number lookarounds from speaker rename. The related `ACTION_ITEM_REGEX` alternatives are Low because other action cues still work. | `phrasebook.ts:63-74`, `summary.ts:15` |
| Registry embeddings accept arbitrary dimensions/non-finite values and cosine truncates to the shorter vector | Confirmed, Medium identity-correctness risk. Validate the expected 256 finite values and reject unequal dimensions. | `speaker-registry.ts:63-93` |
| Registry assignment is greedy and input-order dependent | Confirmed, Medium. The earlier label can claim a shared identity even when a later label has a materially higher score; this is broader than a tie/talk-time issue. | `speaker-registry.ts:173-231`, `finalize.ts:309-314` |
| Speaker registry data uses ordinary umask permissions and output `speakers.json` exposes cross-session linkage | Confirmed, Medium privacy. Private file modes must survive every atomic replacement; a one-time `chmod` is insufficient. | `speaker-registry.ts:76-80`, `speaker-registry.ts:256-260`, `finalize.ts:341-345` |
| System-audio silence timeout can fire immediately after a long pause | Confirmed, Medium behavior risk. Reset the silence baseline on the resume transition. | `main.swift:134-153` |

## Low / latent

| Issue | Disposition |
|---|---|
| Quoted `~/...` is not expanded for finalize/tag/tags | Confirmed Low. Unquoted `~` is normally expanded by the shell; quoted paths usually fail rather than successfully writing under `./~`. |
| `formatDuration(59.6)` renders `0m 60s` | Confirmed Low. Round total seconds before splitting units. |
| `relabelSegments()` is not idempotent for already canonical labels | Confirmed Low and latent because the current caller supplies raw IDs. |
| Equal-overlap speaker assignment depends on raw segment order | Confirmed Low. Define a deterministic tie-break. |
| `doctor [target]` and import `--model` silently coerce invalid values | Confirmed Low/Medium. Reject unsupported choices at the CLI boundary. |
| `process.exit(1)` inside guarded sections skips cleanup | Confirmed Low/Medium for leaked enrollment temp directories. The global final-pass lock becomes stale and normally self-cleans; it is not a permanently live lock. |
| Literal NUL bytes in `diarization-ab.ts` make tools classify it as binary | Confirmed hygiene issue. Use a source escape or structured key instead. |
| Interleaved Float32/Int16 channel extraction uses scalar rather than frame stride | Confirmed latent Low issue. |
| Per-buffer loudest-channel selection conflicts with the documented channel-0 VoiceProcessing workaround | Confirmed Low quality risk. Use channel 0 consistently or select once after calibration. |
| Resampling below 16 kHz is unsupported and would write incorrect-duration audio | Confirmed latent Low issue on normal Mac hardware. |
| No file/directory fsync before rename | Confirmed Low power-loss durability gap, distinct from normal process-crash atomicity. |
| No SIGHUP handler in Node or Swift | Confirmed Low/Medium for terminal sessions. SIGHUP is graceful-capable termination, not a hard kill; menu-bar sessions normally have no controlling terminal. |
| Unsupported-script titles can produce empty/trailing-hyphen slugs | Confirmed Low. Trim after truncation and provide a fallback slug. |
| Relative retitle/ask paths can fail active-session comparison | Confirmed Low. Compare resolved absolute paths. |
| CLI version is hardcoded | Informational drift risk; currently matches `package.json`. |
| `checkSetup` has an unused mode parameter; CLI duplicates `writeSession` implementation | Informational cleanup. The session is not written twice. |
| PID reuse and EPERM liveness behavior | Accepted single-user tradeoff; document it. |

## Incorrect or overstated findings

- `%03d` does not overflow at chunk 1000; it emits `1000`. Core production
  consumers already parse and sort chunk indexes numerically. Keep the
  variable-width parsing contract.
- `formatDuration` in talk time and recorder countdown are not actionable
  duplication: one renders `12m 30s`, the other `12:30`.
- `speakerSortKey` implementations have different special-case semantics and
  should not be merged mechanically.
- A lost start race does not normally pollute dashboard because the orphan has
  no `meta.md`.
- A one-time `chmod 0600` on `registry.json` is not sufficient because the next
  atomic replacement creates a new inode with default mode.

## Privacy notes

Voice embeddings, names, meeting IDs, and match scores are biometric linkage
data. The registry feature is opt-in and backend-scoped, and session WAVs are
deleted after finalization, but the following remain:

- registry JSON and `matches.log` use ordinary umask-derived modes;
- the registry directory is not explicitly private;
- `speakers.json` embeds stable cross-session IDs next to shareable output;
- `matches.log` and quarantined entries have no retention policy;
- corrupt registry JSON silently loads as empty and can later be replaced.

Required baseline: registry directory `0700`; registry temp/final files and
match log `0600`; preserve private modes across atomic writes. Moving stable
global IDs out of meeting output is a design decision in the implementation
spec, not a prerequisite for the permission fix.

## Duplication / hygiene

- `expandPath` is copied in phrasebook, triggers, and vocabulary in addition to
  storage. Consolidation is safe but not a reliability prerequisite.
- Phrasebook/Triggers/Vocabulary hot-reload scaffolding is structurally
  similar. Avoid a generic abstraction until behavior is stable.
- Phrasebook compilation is affected by `allowRegex`, but the cache reload is
  driven only by path/mtime. Toggling the option without changing the file can
  retain stale compiled rules.
- `buildEmbeddingsByLabel` is duplicated in finalization despite an existing
  helper.

## Test suite

Pure logic and contract coverage is strong: real PCM fixtures, captured
payloads, anti-collapse registry tests, overlap-majority labeling, and
echo/duplicate filters.

Major gaps:

- no Swift test target for `WAVWriter`, resampling, channel extraction, restart
  state, pause timing, or signal-driven flush;
- no successful fixture executable exercises the real child-process wiring for
  `whisper-cli`, `AudioAnalysis`, or ffmpeg;
- no active-lock concurrency/malformed-publication test;
- no controller-dead/capture-live orphan-session test;
- no Cyrillic phrasebook boundary or duration rollover test.

## Corrected fix plan

1. **P0 lifecycle and lock protocol:** classify active/orphan/stale recordings;
   surface and block live orphans; make active-lock publication complete before
   visible and refresh it atomically.
2. **P1 Swift stream state:** recover or fail explicitly after WAV I/O errors;
   track storage health; retry system-tap startup while capture remains desired.
3. **P1 validation and start cleanup:** strict numeric/choice parsing, semantic
   config validation, and cleanup of directories owned by a lost start race.
4. **P2 identity/text/privacy:** embedding validation, score-ordered one-to-one
   registry assignment, durable private file modes, and Unicode boundaries.
5. **P3 deterministic/UX cleanup:** pause timeout, duration formatting, path
   normalization, diarization ties/idempotency, NUL source escape, slug fallback,
   and SIGHUP handling.
6. **Defer broad deduplication:** do not combine hot-reload harnesses or
   formatting/sorting helpers as part of the reliability changes.
