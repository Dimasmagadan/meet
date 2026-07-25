# SDD Spec: Speaker Recognition, AI Perf, Codebase & Task Linking

**Date:** 2026-07-24
**Status:** P1+P4 shipped (commit `a25046e`, 2026-07-24) — 397/397 tests pass. S1-Spike resolved 2026-07-24 (cheap path holds). **S1 shipped** (Node side, 428/428 tests pass). **L1 shipped** (453/453 tests pass; new `src/git-context.ts` + `meet link` + `--repo` + meta.md/dashboard surface). **P2+P3 shipped** (473/473 tests pass; new `src/compute-device.ts` + `src/process-priority.ts`; P2 rescoped to doctor device-visibility only — whisper.cpp has no `--metal` flag, see note; `taskpolicy -c utility` QoS at the shared whisper + parakeet/diarize spawns). Next: **L2 → S2**.
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Three workstreams from a project review of the `meet` repo (master @ current). All local; no cloud; no host-pressure regressions on the 16 GB host.

| Workstream | Goal |
|---|---|
| **S** Speaker recognition | Cross-session speaker identity (auto-recognize the same person across meetings) + a measured diarizer-backend A/B |
| **P** AI performance | Gate every heavy model pass on system pressure; Metal/QoS; make CoreML load visible — so local models never overload the host |
| **L** Linking | Git repo auto-attach to meetings; transform bare Bitrix task numbers into full URLs (text only, no API) |

### Key measured facts driving the plan

- **Diarization models = 13 MB total, already on disk** (`pyannote_segmentation` 5.5M + `wespeaker_v2` 7.6M + `plda-parameters.json` 88K + `xvector-transform.json` 176K). The 1 GB FluidAudio cache is **Parakeet** (461M + 586M), not diarization. → **a diarizer-backend A/B adds ~0 disk.**
- Current diarizer (`DiarizeCommand.swift:25` → legacy `DiarizerManager`) uses `wespeaker_v2` internally → **already computes 256-d embeddings**, just doesn't expose them in its output. → **The registry can ship without a backend switch.**
- `getSystemPressure()` (`system-monitor.ts:113`) gates **only** the cheap extractive summary today — the heavy passes (live whisper, final pass, parakeet, diarize, opencode) all ignore system load. → **backwards; biggest perf win to fix first.**
- `phrasebook.ts:61` escapes every pattern (`escapeRegex`) → **no regex/capture-group mode**; the Bitrix URL rewrite needs a tiny capability add (not a new module).

### Resolved decisions (review 2026-07-24)

- **Local generative LLM: deferred.** opencode stays as-is (model is opencode's own config, may be cloud). No MLX/llama.cpp plumbing in this spec.
- **Bitrix: NO API integration.** No PULL, no PUSH, no network, no webhook. L2 is a pure text transform: `номер задачи 1234` → full URL. Tasks are usually referenced by name; only explicit numeric mentions are rewritten (no fuzzy name matching).
- **`speakerRegistryEnabled` default `false`** — opt-in, since voice embeddings are biometric data.
- **Diarizer backend: no blind switch.** S2 is an opt-in parallel A/B pass; the default only flips after measured comparison on real meetings. ~0 disk delta (models already present).
- **One PR per step.** Order: P1+P4 → S1 → L1 → P2+P3 → L2 → S2 (front-loads no-risk wins).

### Non-goals

- Local generative LLM (MLX/llama.cpp) — deferred; opencode unchanged.
- Bitrix REST API (PULL/PUSH), webhooks, auth, user maps — out of scope; L2 is text-only.
- Fuzzy/semantic task-name matching — too fragile; only explicit numeric mentions.
- Mic↔sys echo/bleed correlation — lower ROI than the registry.
- Live/streaming diarization — `meet` diarizes at finalize only.
- Within-chunk speaker splitting — one chunk = one label (carried over from `SPEC_SPEAKERS`).
- Cross-session speaker identity across users — single-user local tool.

---

## 2. Workstream S — Speaker Recognition

### S1. Cross-session speaker registry (ships first, current backend, no Swift model change)

#### Problem
`speakers.json` is per-meeting only; the same physical person gets unrelated `Speaker N` labels across meetings (`SPEC_MYMEET_FEATURES_2026-07-23.md:24`). `meet rename` patches one meeting at a time. FluidAudio exposes speaker embeddings but they are never invoked (`SPEC_SPEAKERS_2026-07-03.md:27`).

#### Constraint that shapes the design
Diarization runs at finalize, when WAV chunks are still on disk (session dir is `rm`'d at `finalize.ts:467`). The diarize step already concatenates sys chunks into `sys-concat.wav` (`diarization.ts:27-73`) and runs `AudioAnalysis diarize`. The legacy `DiarizerManager` already clusters via `wespeaker_v2` embeddings internally — so per-speaker embeddings exist at that point and only need to be surfaced, not recomputed.

#### Backend (Swift) — small output extension

> ✅ **Shipped as part of S1-spike (2026-07-24).** Implemented exactly as specified below; `swift build -c release` clean. This completes the **Swift half of S1** — what remains for S1 is the Node side (registry, finalize wiring, CLI, tests).

`native/AudioCapture/Sources/AudioAnalysis/DiarizeCommand.swift`: after `manager.performCompleteDiarization(...)` (line 36), read `manager.speakerManager` and emit each raw speaker id's existing embedding (WeSpeaker 256-d) in the diarize JSON output:

```json
{ "segments": [...], "speakerCount": 2, "durationMs": 90000,
  "embeddings": { "1": [256 floats], "2": [256 floats] } }
```

No new subcommand, no `sys-concat.wav` slicing, no extra inference — embeddings already live in the manager's speaker state.

> **Spike gate (blocks PR ordering, do FIRST):** a ~30-min Swift spike answers one question — after `performCompleteDiarization`, can we read enumerable per-speaker embeddings from `manager`/`speakerManager` for ~0 cost, or must we fall back to the `embed` subcommand (extra inference)? Verify the exact `SpeakerManager` / `Speaker.currentEmbedding` API against FluidAudio v0.15.4 source (repo pins `0.15.4` per `Package.resolved`, spec referenced 0.12.4+). FluidAudio docs confirm `diarizer.extractEmbedding(audio)` and `speakerManager.getSpeaker(for:)` returning a `Speaker` with `currentEmbedding`.
> - **Cheap path holds** → S1 stays "ship second" (one additive JSON field, ~0 cost).
> - **Fallback needed** → slice `sys-concat.wav` per-segment in Node + `AudioAnalysis embed --input <wav>` calling `diarizer.extractEmbedding(samples)` (still local, one CoreML model, but a real extra inference pass). This is a materially heavier S1 — **reorder it behind L1/P2** since the "~0 cost" justification for shipping it second no longer holds.
>
> ✅ **RESOLVED 2026-07-24 — cheap path holds (no reorder).** Verified against FluidAudio 0.15.4 source + `swift build -c release` clean: `DiarizerManager.speakerManager` is a public var populated by `performCompleteDiarization` (via `assignSpeaker`); `SpeakerManager.getAllSpeakers() -> [String: Speaker]` is public — one-call enumeration; `Speaker.currentEmbedding: [Float]` is the L2-normalized 256-d WeSpeaker vector (`SpeakerManager.embeddingSize == 256`). `DiarizeCommand.swift` now emits `"embeddings": { "<speakerId>": [256 doubles] }` keyed by ids present in `result.segments` (filtered to drop fragmented-speech phantoms that `assignSpeaker` registers on total duration but `createSegmentIfValid` drops below `minSpeechDuration`); the existing Node parser (`diarization.ts:118`) reads only `segments` and ignores the new field, so it's backward-compatible. No `AudioAnalysis embed` subcommand exists today (would've been the fallback) — moot. **S1 proceeds in its current order.**

#### Node — new `src/speaker-registry.ts`

```ts
interface RegistrySpeaker {
  id: string;                 // stable nanoid
  name: string | null;        // null until a user names them
  embedding: number[];        // 256-d, L2-normalized WeSpeaker
  backend: "diarizer-manager" | "vbx-offline";  // producer of `embedding` — matching is backend-scoped
  quarantined?: boolean;      // set when a backend flip retires this entry (kept for audit, never matched)
  createdAt: string;          // ISO
  sourceMeetingId: string;    // first meeting that produced this voice
  matchCount: number;         // how many meetings matched it since creation
}
interface SpeakerRegistry { version: 1; speakers: RegistrySpeaker[]; }

function loadRegistry(path: string): SpeakerRegistry                 // missing → {version:1,speakers:[]}
function cosineSimilarity(a: number[], b: number[]): number
function matchSpeaker(emb: number[], registry: SpeakerRegistry, threshold: number): RegistrySpeaker | null
                                                                     // max cosine ≥ threshold, else null
function registerOrUpdate(rawId: string, emb: number[], meetingId: string, registry: SpeakerRegistry): RegistrySpeaker
                                                                     // no match → push new unnamed entry; returns the entry
function saveRegistry(reg: SpeakerRegistry, path: string): void      // writeAtomic (.tmp → rename)
```

#### Finalize wiring
`src/finalize.ts:175-234` (`runDiarizationStep`), after `runDiarizer` returns segments + (now) embeddings and `relabelSegments`/`assignSpeakers` run: for each raw speaker id that has an embedding, `matchSpeaker()` against the registry:

- **Above `speakerMatchThreshold`** → use the registry speaker's `name` (if any) as the display label instead of a fresh `Speaker N`; bump `matchCount`.
- **Below** → `registerOrUpdate()` as an unnamed `Speaker N` (its label becomes its first-meeting label; renamable later).

Persist into `speakers.json` (schema at `finalize.ts:446`), per speaker:
```json
{ "globalSpeakerId": "<registry nanoid>", "matchedName": "Женя" | null }
```
The existing canonical `Speaker N` id and `speakerNames` map are unchanged; `globalSpeakerId`/`matchedName` are additive. Gated by `config.speakerRegistryEnabled` (default `false`); when disabled, behavior is identical to today.

#### `meet rename` extension
`src/speaker-rename.ts`: when renaming `Speaker N` → `Женя` in a meeting whose `speakers.json` carries a `globalSpeakerId` for that speaker, **also** write `name: "Женя"` into the matching registry entry. → That voice is then auto-named in all future meetings. A single meeting with no registry match falls back to today's local-only rename.

#### Config (`src/types.ts`, `DEFAULT_CONFIG`)
```ts
speakerRegistryEnabled: boolean;      // default false (opt-in; biometric)
speakerMatchThreshold: number;        // default 0.75
speakerRegistryPath: string;          // default "~/.meet/speakers/registry.json"
```
`meet doctor` reports: registry enabled (yes/no), path, speaker count.

#### Backend coupling (S1↔S2) — matching is backend-scoped
`matchSpeaker()` compares cosine **only against entries with the same `backend`**. S2's proposed flip from the online `DiarizerManager` to `OfflineDiarizerManager` (VBx) extracts embeddings via a different path (`speakerDatabase`); same WeSpeaker model, but different segmentation/pooling shifts the distribution, so a fixed 0.75 cosine threshold is not portable across backends. Session WAVs are `rm`'d at `finalize.ts:478`, so **post-hoc re-embedding of old meetings is impossible** — the registry is the only surviving voice state.

On a backend flip: mark all prior-backend entries `quarantined: true` (kept for audit, never matched), and let the new backend re-register voices from scratch. Documented explicitly; no silent cross-backend matching.

#### Review / unmerge surface (biometric floor)
False merges (two people → one identity, then a name propagates across meetings) are the failure mode and are otherwise invisible. Minimum surface shipped with S1:
- Append every borderline decision to `~/.meet/speakers/matches.log` — `<meetingId> <globalId> matched "<name>" @ <score> (threshold <t>)`.
- `meet speakers list` — registry entries with `matchCount` + recent borderline matches from the log.
- `meet speakers forget <globalId>` — drops a bad identity so the next meeting re-registers that voice fresh.

Full split/merge editing is deferred — this is the honest floor given the opt-in biometric scope.

#### Known ceilings (S1, intentionally deferred)
- **Fixed threshold, frozen embeddings.** Matching uses a fixed `speakerMatchThreshold` (default `0.75`) against the first-seen 256-d WeSpeaker vector. There is no centroid update across meetings and no per-voice threshold tuning — recall is bounded by how representative the first chunk's embedding is.
- **No `matches.log` rotation.** The log is append-only and unbounded; a long-running install will need manual cleanup or a future rotation pass.
- **Same-run diarization is treated as ground truth.** Two labels cleared against one registry entry in the same finalize do not collapse — Speaker 1 claims it, Speaker 2 re-registers (see `applyRegistryToSpeakers` claimed-set guard). This trades rare split-then-merge fixes for predictable per-meeting semantics.
- **No bulk purge / encryption at rest.** `meet speakers forget <globalId>` is per-id only; embeddings are stored as plain JSON. A future `--all` companion and on-disk encryption are the obvious privacy hardening.

#### Privacy
Embeddings only (no raw audio), local disk only, opt-in. Documented in README + `meet doctor`.

#### Tests
`src/speaker-registry.test.ts`:
- `cosineSimilarity` correctness (orthogonal → 0, identical → 1).
- match above threshold returns nearest; below threshold returns null.
- `registerOrUpdate` dedups (re-match same embedding updates matchCount, doesn't duplicate).
- match is backend-scoped: an identical embedding under a different `backend` does NOT match (returns null → new entry).
- `meet speakers forget <globalId>` drops the entry; the next finalize re-registers that voice.
- registry persisted atomically; idempotent re-run.
- finalize integration (mock diarize JSON with embeddings): two meetings with the same voice → second auto-labels with the first's name.
- `meet rename` writes name to registry; a subsequent finalize auto-applies it.

**Acceptance checks (seam guards, no Swift in CI):**
- `diarization.test.ts`: a captured diarize JSON containing `{ "embeddings": {...} }` parses and threads embeddings through to the registry — pins the Swift→Node JSON contract without running the Swift binary.
- `speaker-registry.test.ts`: flip `backend` → prior-backend entries are marked `quarantined` and an identical embedding under the new backend does **not** match (re-registers fresh).

---

### S2. Diarizer A/B (opt-in, measured, decide later)

#### Problem
FluidAudio's own docs mark the legacy `DiarizerManager` as the *worst* option ("most computationally heavy online diarizer; performs poorly"). `OfflineDiarizerManager` (VBx) is "the best offline-quality option" for batch, is batch-optimized for finalize-only use, and exposes per-speaker embeddings directly via `speakerDatabase`. The VBx models (`pyannote_segmentation` + `wespeaker_v2` + `plda-parameters` + `xvector-transform`) are **already on disk** — the switch is a clustering-algorithm change, not a download.

#### Change
Add `OfflineDiarizerManager` as a **parallel** pass mirroring the Parakeet A/B pattern (`finalize.ts:454`), gated by `diarizationAbPass` (default `false`). It re-diarizes `sys-concat.wav` and writes `diarization-ab-report.json`:
- primary vs A/B speaker counts
- per-segment label diff (agreement %, swaps)
- talk-time diff per speaker
- embedding cosine self-agreement between the two labelings

It does **not** modify `transcript.md`. Wrapped in try/catch fail-open.

#### Decision gate
After 2-3 real meetings, compare the report. If VBx is clearly better (more stable labels, fewer splits/merges), flip the default. **No blind switch.**

#### Config
`diarizationAbPass: boolean` (default `false`).

---

## 3. Workstream P — AI Performance (local, 16 GB host)

### P1. System-pressure gates on all heavy passes  *(biggest single win)*

> ✅ **Shipped** (commit `a25046e`). `whenNotOverloaded()` + `makeDeadline()` in `system-monitor.ts`; one per-pass wall-clock budget wired into `runFinalPass`, `runParakeetPass`, `runDiarizationStep` (each gains an optional injectable `sensor?` for tests). New config: `gateHeavyPasses` (default `true`), `gateBudgetMs` (default `120000`). Live path (`pipeline.ts`) un-gated and pinned by a source-level seam-guard test. Tests: `system-monitor.test.ts` (whenNotOverloaded/makeDeadline), new `final-pass.test.ts` + `pipeline.test.ts`. **Not yet done:** `meet doctor` CoreML/device lines belong to the P2+P3 PR.

#### Problem
`getSystemPressure()` (`system-monitor.ts:113-144`) reads 1-min loadavg, free memory, and `pgrep whisper-cli`. It is wired into **exactly one** consumer: `SummaryScheduler` (`summary.ts:391-441`) — i.e. the *cheapest* work in the system. Live whisper (`pipeline.ts:147`), the final pass (`final-pass.ts`), the parakeet pass (`parakeet-pass.ts:45`), diarize (`finalize.ts:228`), and opencode (`finalize.ts:458`) all ignore load and run back-to-back in one finalize process.

#### Scope decision — batch passes only, NOT the live path
The gate applies **only to the finalize/batch passes**, which run sequentially in one process (`finalize.ts:409` final → `:433` diarize → `:455` parakeet → `:461` opencode). The **live path is deliberately excluded**:
- `pipeline.ts:147` (`processNext`) is already self-throttling — it guards on `this.processing`, so exactly one live whisper runs at a time; during live recording that whisper *is* the one heavy process. Gating it adds nothing.
- Swift keeps writing a chunk every ~15s regardless of load; blocking `processNext` under pressure just backs up the unbounded live queue (`pipeline.ts:23`) with no producer-side pause — it manufactures the very lag P5 surfaces. The two would be in tension.
- 1-min `vm.loadavg` (`system-monitor.ts:38` docstring) is a 60s-smoothed signal; gating a 15s-cadence loop on it is mistimed by design.
- The **drain pass** (small-model, post-stop `stop()`) also stays un-gated — the user is actively waiting on it.

Live-path pressure is instead handled by: self-throttling (above) + P3 QoS (live whisper keeps higher priority than batch children) + the existing `waitForInactiveRecording` (`finalize.ts:404`) which already yields the final pass to an active recording. P5 stays visibility-only for the live queue — now consistent, not in tension.

#### Change
New shared helper in `src/system-monitor.ts`:
```ts
async function whenNotOverloaded(deadline: { pollMs?: number; remainingMs(): number }): Promise<void>
// polls getSystemPressure(); while overloaded AND deadline.remainingMs() > 0, await sleep(pollMs) (default 2000);
// fail-open (return) if sensor unavailable or deadline exhausted.
```
Each gated **pass** sets ONE wall-clock budget when it starts (e.g. `gateBudgetMs`, default ~120000) and threads a `remainingMs()` deadline into every per-chunk call. This bounds the *whole pass*, so a many-chunk pass can't stall `N × maxWaitMs` — the per-call `maxWaitMs` cap is explicitly rejected because it doesn't bound total finalize time.

Wire as a guard at the start of each **batch** pass:
- `src/final-pass.ts` — one budget per pass; check before each medium-model chunk.
- `src/parakeet-pass.ts:45` — one budget per pass; check before each `AudioAnalysis transcribe`.
- `src/finalize.ts:228` — before `runDiarizer` (single call, budget trivially the whole diarize).

Effect: a stacked finalize (medium whisper → diarize → parakeet → opencode) backs off under load instead of melting the machine, while the live meeting transcription is never stalled.

#### Config
`gateHeavyPasses: boolean` (default `true`); `gateBudgetMs: number` (default `120000`, per-pass wall-clock cap); reuses existing `cpuThresholdLoad` (6) and `memThresholdMb` (768).

### P2. Metal/GPU flags on whisper

> ✅ **Shipped (rescoped 2026-07-25 after review).** New `src/compute-device.ts`: `detectWhisperCompute(bin)` runs `whisper-cli --help` once (cached per binary path), `parseWhisperHelp(stderr)` pure parser unit-tested against a captured fixture. `meet doctor` prints `compute: Metal — Apple M2 Pro`.
>
> ⚠️ **Rescope from the literal spec wording.** The spec proposed "add `--metal`, detect via `--help` probe, fail-open if unsupported." On verifying against the installed binary, **whisper.cpp exposes no positive `--metal` flag at all** — GPU is on by default and the only knobs are `-ng`/`--no-gpu` (disable) and `-dev N`/`--device N` (select). Given the negative-flag design there is no plausible future `--metal` build, so the entire flag-emission path (`metalFlagSupported`, `addMetalFlag`, the `whisperMetal` config key, both call sites) is dead code and was removed. What ships is the **device-visibility** half: `detectWhisperCompute` parses the backend-init log on stderr for `loaded MTL backend` + `GPU name:`, so `meet doctor` reports the active device. P2 is now doctor-only; transcription args are byte-identical to before.
>
> 🔴 **Bug caught + fixed in review:** an intermediate draft detected `-ngl`/`--ngl` as a metal-flag alias and would have emitted `--metal` — but `-ngl` is a llama.cpp flag whisper.cpp has never had, so a hypothetical `-ngl`-advertising build would have received an unknown `--metal` arg and failed every chunk. Removed. Key gotcha pinned by the parser: `whisper-cli --help` writes the option list **and** backend-init log to **stderr** (stdout is empty). Fail-open to empty info on any error.

`buildWhisperArgs` (`transcriber.ts:81-108`) passes no GPU flags; Metal use depends on the brew build's defaults. Add `--metal` (detect whisper-cli support via a one-shot `whisper-cli --help` probe cached at startup; fail-open to no flag if unsupported). Measure wall-time delta on a sample WAV before/after. `meet doctor` reports the active compute device (CPU vs Metal) if detectable.

### P3. Process priority (QoS)

> ✅ **Shipped** (2026-07-25). New `src/process-priority.ts`: `buildQoSArgs(cmd, args, {enabled, available})` pure builder (unit-tested) wraps as `taskpolicy -c utility <bin> <args…>`; `applyQoS` sync wrapper (both inputs — `config.lowerProcessPriority` + `existsSync('/usr/sbin/taskpolicy')` — are sync, so the earlier `async` form was reverted in review to avoid pointless `await`s at three hot spawn sites); `isTaskpolicyAvailable()` cached. Wired at `transcriber.ts` `transcribeChunk` (the shared spawn → covers **both** live + final), `parakeet-pass.ts transcribeWithParakeet`, `diarization.ts runDiarizer`. `import.ts runWhisper` gets **no** QoS (foreground user batch, outside a live recording — per spec). `meet doctor` prints `process priority: taskpolicy -c utility (whisper/AudioAnalysis lowered; capture keeps priority)`.
>
> ⚠️ **Scope note:** the spec listed `final-pass.ts` for QoS, but that pass calls `transcribeChunk` (the now-wrapped shared spawn), so it's covered transitively — `final-pass.ts` itself needed no change. `taskpolicy` stops option parsing at the first non-option arg, so the wrapped binary's own `-m`/`-c`/`--input` flags survive verbatim (verified: `taskpolicy -c utility whisper-cli -c` → whisper itself rejects `-c`, proving it wasn't swallowed).
>
> **Complementary to P1, not in tension:** P3's QoS lowering applies to the **live** whisper path too (via the shared `transcriber.ts:200` spawn). This is correct — P1 keeps the live path *un-gated* (a pressure gate would back up the unbounded live queue), but QoS is categorically different: it never stalls, it only deprioritizes scheduling under contention. So when capture (Swift, default priority) and live whisper compete, capture wins → no audio dropouts, only transient live-text lag. Capture integrity > live-text latency. Gated by `lowerProcessPriority` (default `true`); fail-open when `taskpolicy` absent.

Spawn `whisper-cli` / `AudioAnalysis` with lowered priority so the Swift audio capture never starves during live recording. Apply `taskpolicy -c utility` (macOS background utility class) and/or `nice` on spawn options at: `transcriber.ts:200`, `parakeet-pass.ts:11`, `diarization.ts:109`. `AudioCapture` (capture) keeps default priority.

### P4. CoreML load visibility

> ✅ **Shipped** (commit `a25046e`). `isAudioAnalysisRunning()` (`pgrep -f AudioAnalysis`) + `audioAnalysisRunning` field on `ResourcePressure`, surfaced in `reason` when overloaded (e.g. `cpu 9.0/8c, whisper+audioAnalysis`).
>
> ⚠️ **Design deviation from the literal spec wording:** "combine into the existing `overloaded` boolean" was implemented as **threshold-based only** (load/mem); the heavy-child flags are informational, *not* OR'd into `overloaded`. Rationale: a multi-chunk pass (final/parakeet) spawns→awaits→exits one child per chunk, so the 5s pgrep cache is stale-`true` immediately after each child exits — OR-ing it in would make the per-chunk gate back off during its own pass, manufacturing 2–4s artificial delay per chunk (hundreds of seconds over a long pass). The load/mem thresholds already trip when loadavg is high regardless of which child caused it, so "(any heavy child running + high loadavg → back off)" still holds. If a maintainer wants the boolean itself to reflect heavy-child presence, it's a one-line change — but it would regress the gate. Documented inline in `system-monitor.ts:getSystemPressure`.

`system-monitor.ts:98` only `pgrep`s `whisper-cli`. Add `pgrep -f AudioAnalysis` so P1's gate actually sees diarize/parakeet CoreML pressure (currently invisible). Combine into the existing `overloaded` boolean (any heavy child process running + high loadavg → back off).

### P5. Backpressure on the live queue
`pipeline.ts:23` queue is unbounded; lag is computed (`recorder.ts:440-443`) but never acted on. When lag exceeds `liveQueueLagWarnChunks` (default ~8 chunks ≈ 2 min), emit a status warning line. No chunk dropping in MVP — visibility only.

#### Tests
`src/system-monitor.test.ts` extension:
- `whenNotOverloaded` resolves immediately when not overloaded.
- awaits (re-polls) while overloaded; resolves once load drops.
- resolves once `deadline.remainingMs()` hits 0 even if still overloaded (per-pass budget bounds total wait).
- fail-opens (returns immediately) when the sensor returns null.
- existing `parseLoadavg`/`parseFreeMemoryMb` tests already cover sensor parsing.

**Acceptance checks (behavioral, plain `node:test`, injected fake sensor — these pin the P1 rescope, replacing the manual "Verify" cell):**
- `final-pass.test.ts`: overloaded sensor + tiny `gateBudgetMs` → the pass calls the gate AND still returns (doesn't hang) once the budget expires.
- `pipeline.test.ts`: overloaded sensor → a live chunk still transcribes with **no wait** (proves the live path is un-gated — the core promise of the rescope; a unit test on `whenNotOverloaded` alone cannot prove the wiring excludes `pipeline.ts`).

---

## 4. Workstream L — Codebase & Task Linking

### L1. Git auto-detect + `meet link`

#### New `src/git-context.ts`
```ts
interface GitContext { repoPath: string; repoName: string; branch: string | null; headSha: string; }
function detectGitContext(cwd: string): GitContext | null
// walk up to nearest .git; lightweight `git rev-parse HEAD` + `symbolic-ref --short HEAD`; repoName = basename(repoPath). Fail-open (null) if not in a repo or git missing.
```

#### At `meet start`
Capture from `process.cwd()`; persist into `session.json` + `meta.md` as `- Repo: <name> @ <short sha> (<branch>)`. New `--repo <path>` start flag overrides cwd. Fail-open silently if not in a repo.

#### `meet link <meetingDir> <repoPath>`
Post-hoc attach/replace repo context in an existing meeting (mirrors the `meet rename` arg convention, `cli.ts:83-91`). Re-detects from `<repoPath>` and rewrites the `- Repo:` line in `meta.md` atomically.

#### Dashboard
`parseMetaFile` (`dashboard.ts:8-31`) gains a `- Repo:` regex; `meet dashboard` surfaces repo in the meeting list.

**No network, pure local.**

### L2. Phrasebook regex mode → Bitrix task-number → full URL

#### Problem
`phrasebook.ts:61` escapes every `from` with `escapeRegex`, so regex patterns and capture-group backrefs are impossible. The desired transform — `номер задачи 1234` → `номер задачи https://sam.optimacros.com/workgroups/group/64/tasks/task/view/1234/` — needs a capturing regex.

#### Change (general capability, not Bitrix-specific)
Extend `src/phrasebook.ts`:
- Add `regex?: boolean` to `PhrasebookRuleInput` (line 8).
- In `_build` (lines 54-67): when `entry.regex` is true, compile `entry.from` as a **raw** regex (skip `escapeRegex` and skip the `wordBoundary` wrap, which is incompatible with a raw pattern). `to` supports `$1`–`$9` backrefs natively (JS `String.prototype.replace` already handles backrefs in the replacement string). Invalid regex → skip the rule (existing `try/catch` at line 62-66, fail-open).
- **ReDoS floor:** cap raw-regex `from` length (≥500 chars → skip the rule). The `try/catch` only catches compile failures; a *valid* catastrophic-backtracking pattern compiles fine and then runs on every chunk (live + import + parakeet). JS regex is synchronous, so there's no timeout guard — the length cap + this note is the pragmatic mitigation for a single-user local tool editing its own `phrasebook.json`.
- Existing literal rules are unchanged.

#### Seed `phrasebook.json` with a default Bitrix rule
User-editable, hot-reloadable (same convention as `triggers.json`/`vocabulary.json`):
```json
{
  "from": "(номер\\s+задачи(?:\\s+в\\s+битриксе)?[^0-9А-Яа-яЁё]{0,8})(\\d{2,})",
  "to": "$1https://sam.optimacros.com/workgroups/group/64/tasks/task/view/$2/",
  "regex": true,
  "caseInsensitive": true
}
```
Effect: `номер задачи 1234` and `номер задачи в битриксе 1234` → the number is expanded to the full URL. The trigger phrase is required (conservative) to avoid false positives on arbitrary numbers; the user can add/tune more rules in `phrasebook.json` at will. Applied to all transcript output via the existing `getPhrasebook(config).apply()` call (`transcriber.ts:215-217`), live + import + parakeet passes — no new call sites, **no network**.

#### Tests
`src/phrasebook.test.ts` extension:
- raw-regex rule applies.
- `$1`/`$2` backrefs resolve.
- invalid regex is skipped (no throw, other rules still apply).
- literal rules still work (regression guard).
- the Bitrix rule turns a sample `номер задачи 1234` mention into the full URL.

---

## 5. File-changes summary

| File | Change | Workstream |
|---|---|---|
| `native/AudioCapture/Sources/AudioAnalysis/DiarizeCommand.swift` | emit `embeddings` per raw speaker id in diarize JSON | S1 — ✅ shipped (S1-spike) |
| `src/speaker-registry.ts` | **new** — registry load/save, cosine, match/register | S1 |
| `src/speaker-registry.test.ts` | **new** | S1 |
| `src/diarization.ts` | parse `embeddings` from diarize output; thread through | S1 |
| `src/finalize.ts` (`:175-234`) | registry match/register; persist `globalSpeakerId`/`matchedName` | S1 |
| `src/finalize.ts` (`:454`) | optional `diarizationAbPass` parallel block → `diarization-ab-report.json` | S2 |
| `src/speaker-rename.ts` | `meet rename` also writes name into matched registry entry | S1 |
| `src/types.ts` | `speakerRegistryEnabled`, `speakerMatchThreshold`, `speakerRegistryPath`, `diarizationAbPass`, `gateHeavyPasses`, `gateBudgetMs`, `liveQueueLagWarnChunks`, `lowerProcessPriority`, git context persistence | S1/S2/P1/P3/P5/L1 |
| `src/system-monitor.ts` | `whenNotOverloaded()`; `pgrep AudioAnalysis` | P1/P4 |
| `src/system-monitor.test.ts` | `whenNotOverloaded` cases | P1 |
| `src/compute-device.ts` | **new** — `detectWhisperCompute`/`parseWhisperHelp` (`whisper-cli --help` stderr probe, cached; device-visibility only — no flag emitted) | P2 — ✅ shipped (rescoped) |
| `src/compute-device.test.ts` | **new** — captured-help fixture, fail-open/cache cases | P2 — ✅ shipped |
| `src/process-priority.ts` | **new** — `buildQoSArgs`/`applyQoS` (sync; `taskpolicy -c utility` wrap, fail-open) | P3 — ✅ shipped |
| `src/process-priority.test.ts` | **new** — pure builder + config-flag + availability cases | P3 — ✅ shipped |
| `src/transcriber.ts` (`:200`) | QoS spawn wrap via shared `transcribeChunk` (no `--metal` — whisper.cpp has no such flag) | P3 — ✅ shipped |
| `src/pipeline.ts` | **no change** — live path deliberately un-gated (self-throttling); P5 status warning only | P1/P5 |
| `src/final-pass.ts` | `whenNotOverloaded()` guard (P1); QoS via shared `transcribeChunk` (P3, no direct change) | P1 ✅ /P3 ✅ transitively |
| `src/parakeet-pass.ts` (`:11`,`:45`) | `whenNotOverloaded()` guard + QoS | P1/P3 — ✅ shipped |
| `src/diarization.ts` (`runDiarizer`) | QoS spawn wrap (`taskpolicy -c utility`) | P3 — ✅ shipped |
| `src/import.ts` (`runWhisper`) | **no change** (metal-flag probe + `addMetalFlag` removed in review as dead code; foreground user batch, no QoS) | P2 — ✅ rescoped to no-op |
| `src/git-context.ts` | **new** — repo detect | L1 — ✅ shipped |
| `src/git-context.test.ts` | **new** — 17 cases (detect/format/parse/apply/link, atomic write, fail-open) | L1 — ✅ shipped |
| `src/cli.ts` | `meet link` command; `meet speakers list` / `meet speakers forget <globalId>`; `--repo` start flag; doctor registry/metal/CoreML lines | L1 ✅ /P2 ✅ /P4 ✅ /S1 |
| `src/tags.ts` (`writeMetaFile`) / `src/dashboard.ts` (`parseMetaFile`) | `- Repo:` line (write + parse); `MeetingStats.repo` + Repo table column | L1 — ✅ shipped |
| `src/types.ts` | `Session.gitContext?` + `MeetingStats.repo?` | L1 — ✅ shipped |
| `src/recorder.ts` (`promptTags`) | always write meta.md (was skipped when no tags / headless — L1 dependency + dashboard gap fix) | L1 — ✅ shipped |
| `src/phrasebook.ts` (`:8`,`:54`) | `regex?: boolean` raw-regex + backref mode | L2 |
| `src/phrasebook.test.ts` | regex-mode cases | L2 |
| `phrasebook.json` | seed Bitrix URL rule | L2 |
| `README.md` / `AGENTS.md` | document new features | all |

No changes touch the `AudioCapture` recording path (mic/system capture) — all three workstreams operate on finalize-time data, transcript text, or process scheduling. S1 is the only Swift change, and it is additive (one extra JSON field).

---

## 6. Implementation order (one PR per step, each independently mergeable)

| PR | Scope | Risk | Verify |
|---|---|---|---|---|
| ✅ **P1+P4** — shipped `a25046e` | `whenNotOverloaded` gates on **batch passes only** (final/diarize/parakeet), per-pass wall-clock budget, + `pgrep AudioAnalysis` + tests | Low | ✅ `tsc --noEmit` clean, **397/397 tests pass**; acceptance checks (injected overloaded sensor) assert batch backs off AND live path is un-gated. ⚠️ design deviation: `overloaded` kept threshold-based (see P4 note) |
| ✅ **S1-spike** — resolved 2026-07-24 | 30-min Swift spike: are per-speaker embeddings enumerable post-diarization for ~0 cost? | — | ✅ **Cheap path holds.** `manager.speakerManager.getAllSpeakers()` (public) + `Speaker.currentEmbedding` (256-d) read for ~0 cost; `DiarizeCommand.swift` emits `embeddings` field; `swift build -c release` clean. S1 stays in order — no reorder. |
| ✅ **S1 — shipped** (this PR) | registry (backend-stamped, backend-scoped match) + finalize match/register + `meet rename` registry write + `meet speakers list/forget` + matches.log + tests | Med | ✅ **428/428 tests pass** (`tsc` clean); 3 new source files + 5 existing extended; registry round-trip test; rename-then-finalize auto-applies name; acceptance checks cover the diarize-JSON seam + backend-flip quarantine |
| ✅ **L1** — shipped (this PR) | `git-context.ts` + `meet link` + `--repo` + meta.md/dashboard | Low | ✅ **453/453 tests pass** (`tsc` clean); 17 new `git-context.test.ts` cases; real `meet link <dir> .` against this repo → `- Repo: meet @ ab0440e (master)` inserts then idempotently replaces; pre-existing meta.md gap fixed (tag-less/headless meetings now get meta.md) |
| ✅ **P2+P3** — shipped (this PR, rescoped in review) | P2 = doctor device-visibility (`compute-device.ts` parses `whisper-cli --help` stderr; **no `--metal` flag** — whisper.cpp uses negative `-ng`/`--no-gpu` + `-dev N` only, so the proposed flag-emission was dead code and removed). P3 = `taskpolicy -c utility` QoS (`process-priority.ts`, sync `applyQoS`) at shared whisper spawn + parakeet/diarize + doctor priority line | Med | ✅ **473/473 tests pass** (`tsc` clean); +2 modules/+2 test files; `meet doctor` renders `compute: Metal — Apple M2 Pro` + `process priority: taskpolicy -c utility`; QoS arg-forwarding verified. 🔴 review caught: `-ngl`-alias detection would have emitted `--metal` and failed every chunk (fail-open → fail-closed) — removed. Review also dropped: `metalFlagSupported`/`addMetalFlag`/`whisperMetal` config/transcriber+import call sites/4 tests (dead code); `applyQoS` reverted from `async`→sync; nested try/catch flattened. ⚠️ P3 applies to live path too via shared `transcriber.ts:200` spawn — complementary to P1 (QoS yields CPU under contention, never stalls; capture keeps priority) |
| **L2** | phrasebook `regex` mode + Bitrix URL rule + tests | Low | lint/build/test; sample mention → full URL |
| **S2** | opt-in `diarizationAbPass` parallel pass + `diarization-ab-report.json` | Low | run on 2-3 real meetings, compare report, decide on flipping the default |

Front-loads the no-risk wins (P1+P4, then S1, then L1), gives a real measured A/B for the diarizer (S2, your explicit concern), and keeps Bitrix as the tiny text transform you described (L2). Each PR is independently mergeable.
