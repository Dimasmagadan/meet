# SDD Spec: Borrowed Features from MyMeet Onboarding Call

**Date:** 2026-07-23
**Status:** Done — F1, F2, F3 all landed (amended 2026-07-24)
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Reviewed a competitor onboarding call (transcript pasted 2026-07-23, vendor "MyMeet"-style SaaS). Most of their surface (bot-in-call, CRM sync, calendar auto-join, workspace roles) doesn't apply — `meet` is a local, single-user CLI, not a cloud multi-tenant product. Three ideas do map cleanly onto existing modules:

| # | Feature | Outcome |
|---|---------|---------|
| F1 | Speaker rename | `meet rename <meetingDir> "Speaker 1" "Женя"` — persists a real name over a diarized label, rewrites `transcript.md` + `speakers.json` |
| F2 | Custom vocabulary | Hot-reloadable `vocabulary.json` (rare names/terms) folded into the whisper `--prompt` for both live and final passes, alongside the existing static `config.prompt` |
| F3 | Action-items pass for recordings | Wire the already-built `runOpencodeIndex()` (currently only used by `meet transcribe`) into `finalizeSession()`, gated by config, so `meet start` recordings also get `index.md` with Summary/Decisions/Action Items |

Explicitly out of scope (per user request): export formats (JSON/PDF/doc) — already partially covered by markdown output, not part of this spec.

### Non-goals (all three)
- No cloud/multi-user concerns (workspace roles, CRM sync, calendar auto-join, bot customization) — none of that applies to a local single-user tool.
- No custom report-template builder / 30 report types — one enriched prompt (F3) covers the value for a solo user; multiplying templates is speculative.
- No cross-session speaker identity (voice fingerprinting across meetings) — `Speaker N` stays per-session; F1 only renames within one meeting's output.
- No change to whisper's actual vocabulary/decoding beyond what `--prompt` already offers — F2 is honest about being a soft bias, not a hard dictionary override.

### Resolved decisions (2026-07-24 review)

Resolved against the real tree before implementation:

- **F1 output scope** — `meet rename` patches a glob of `transcript*.md` in the meeting dir (covers **both** `transcript.md` and `transcript.parakeet.md`, which share identical `**[HH:MM:SS] Speaker N:**` labels via `rewriteMarkdown` at `finalize.ts:447`/`:273`), **plus** `index.md` (prose — word-boundary replace of the previous display label only). `ab-report.json` is JSON metadata with no labels → explicitly **not** patched. (Original draft missed `transcript.parakeet.md`.)
- **F2 prompt budget** — `toPromptSuffix` sizes against the **combined** string (`config.prompt` + suffix ≤ cap), not the suffix alone, since `config.prompt` is already ~88 chars of Cyrillic and whisper's initial-prompt token budget (~224 tokens) is shared.
- **`escapeRegex` dedup** — currently a byte-identical private duplicate in `phrasebook.ts:97` and `attention.ts:117`. Extract to shared `src/regex-utils.ts`; dedup both call sites and reuse in `speaker-rename.ts`.
- **Sequencing** — one PR per feature, order **F1 → F2 → F3**. Each independently mergeable; PR1's `regex-utils.ts` extraction is self-contained within PR1.

### Landed (2026-07-24)

- **F2 shipped** in `a02ddc4` (`feat(vocabulary): hot-reload custom whisper terms`). As-built notes: `toPromptSuffix` default cap **200**, prefix `. Термины: `, separator `, `, first-in-file terms win (matches `triggers.ts` first-match precedent); `terms` getter returns a defensive copy (minor deviation from `triggers.ts`'s primitive `triggerCount` — guards against external mutation since callers iterate the list). Wired at `transcriber.ts:95` for both live and final passes. Config: `vocabularyPath` (default `./vocabulary.json`), `vocabularyReload: true`. 15 tests pass. Note: this spec doc was left untracked at `a02ddc4` commit time (it spans F1/F3, kept out of the F2 feature commit for atomicity) and is updated by this revision.
- **F1 shipped**: `src/speaker-rename.ts` + `meet rename <meetingDir> <speakerId> <newName>` CLI command. As-built deviation: `index.md` word-boundary match uses Unicode-aware lookaround (`(?<![\p{L}\p{N}])...(?![\p{L}\p{N}])`, `u` flag) instead of `\b`, since `\b` is ASCII-only and would fail to bound a Cyrillic display name on a second rename. 11/11 tests pass (one test fixture bug fixed along the way: a `doesNotMatch(/Женя/)` assertion collided with unrelated spoken-body text containing the same word — narrowed to check label positions only).
- **F3 shipped**: `finalize.ts` now calls `runOpencodeIndex()` + `writeAtomic(index.md)` right after the `parakeetComparePass` block, gated by new `opencodeIndexPass` config (default `false`), wrapped in try/catch that only warns on failure. `meet doctor`'s opencode detection line now reports whether `opencodeIndexPass` is enabled. No dedicated test added — mirrors the existing `parakeetComparePass` wiring in the same function, which itself has no unit test (`finalizeSession()` end-to-end isn't unit-tested anywhere in this codebase; needs live whisper-cli/Swift process, out of scope for `node:test`).

Verified line refs: `assignSpeakers`@`diarization.ts:151`, `rm(sessionDir)`@`finalize.ts:467`, label shape `**[HH:MM:SS] LABEL:**`@`assembler.ts:41`, footer `- L: Nm NNs (P%)`@`talk-time.ts:75`, `runOpencodeIndex`@`opencode.ts:43` (only caller `import.ts:211`), F3 insertion point after the `parakeetComparePass` block@`finalize.ts:455` (inside the `entries.length > 0` block). Minor drift in original draft: `--prompt` is at `transcriber.ts:95`, not `:90`.

---

## 2. F1 — Speaker Rename

### Problem
`assignSpeakers()` (`src/diarization.ts:151`) labels sys entries `Speaker 1`, `Speaker 2`, ... People forget who's who within days (the call transcript names this exact pain). There's no way to attach a real name after the fact.

### Constraint that shapes the design
By the time a user would want to rename, the session directory is already gone — `finalizeSession()` deletes it (`src/finalize.ts:467`, `rm(sessionDir, { recursive: true, force: true })`). So renaming can't be "re-run diarization/finalize"; it must operate on the **finished output directory** (`transcript.md` + `speakers.json` next to it), patching text in place. This is the same atomic-write pattern already used everywhere else in the codebase.

### Data model
`speakers.json` already exists per meeting (written at `src/finalize.ts:445`) with `segments` and `entryAssignments` — **arrays** containing canonical `Speaker N` ids (not maps keyed by id; validate membership via `.some(s => s.speaker === id)`). Add one field, written by the rename command, read by nothing else (purely informational/idempotency record):

```json
{
  "...": "existing fields unchanged",
  "speakerNames": { "Speaker 1": "Женя", "Speaker 2": "Максим" }
}
```

The **canonical id** (`Speaker 1`) never changes — `speakerNames` maps canonical id → current display label. This keeps rename idempotent: renaming twice just overwrites the map entry and re-derives what text to search for from the *previous* display label (falling back to the canonical id if never renamed).

### New module: `src/speaker-rename.ts`

```ts
export interface RenameFileCount {
  file: string;            // basename, e.g. "transcript.md", "transcript.parakeet.md", "index.md"
  bodyMatches: number;     // `**[HH:MM:SS] LABEL:**` replacements (0 on index.md)
  footerMatches: number;   // `- LABEL: ` Talk Time row replacements (0 on index.md and parakeet)
  indexMatches: number;    // bare word-boundary label replacements (only index.md; 0 elsewhere)
}
export interface RenameResult { files: RenameFileCount[] }

// meetingDir must contain speakers.json (post-finalize output dir).
// speakerId is the canonical "Speaker N" id; throws with a three-pronged error matrix
// (see step 1) — never silently no-ops on a typo or a meeting with no diarization.
export async function renameSpeaker(
  meetingDir: string,
  speakerId: string,
  newName: string,
): Promise<RenameResult>
```

Implementation (all in one function, no new abstraction — this is a one-shot CLI operation, not a hot path):

1. Read `speakers.json`; apply a three-pronged error matrix (never silently no-op):
   - file missing → throw `"Not a finalized meeting (no speakers.json in ${meetingDir})"`.
   - `diarization.ok === false` (or session was mic-only / no sys entries) → throw `"No speakers to rename (diarization disabled, failed, or mic-only session)"`.
   - `speakerId` not found in `segments`/`entryAssignments` (`!segments.some(s => s.speaker === speakerId) && !(entryAssignments ?? []).some(a => a.speaker === speakerId)`) → throw `"Unknown speaker: ${speakerId}. Available: Speaker 1, Speaker 2, ..."`.
2. `currentLabel = speakersRecord.speakerNames?.[speakerId] ?? speakerId`.
3. **Glob `transcript*.md`** in `meetingDir` (matches `transcript.md` and, when the Parakeet A/B pass ran, `transcript.parakeet.md` — both are `rewriteMarkdown` output with identical label shape). For each file, apply **two** regexes and count matches:
   - body: `` new RegExp(`(\\*\\*\\[\\d{2}:\\d{2}:\\d{2}\\] )${escapeRegex(currentLabel)}(:\\*\\*)`, "g") `` → `$1${newName}$2` (reuses the label token shape `assembler.ts:41` writes: `**[HH:MM:SS] LABEL:**`).
   - footer: `` new RegExp(`(- )${escapeRegex(currentLabel)}(: )`, "g") `` → `$1${newName}$2` (matches `talk-time.ts:75` row `- Speaker 1: 14m 15s (48%)`).
   - Note: `transcript.parakeet.md` is written without `talkTime` (`finalize.ts:273`), so its footer count is legitimately 0 — that's expected, not a warning.
4. If `index.md` exists (F3 output, prose), apply a **separate** word-boundary replace of `currentLabel` only (NOT the canonical id — minimizes false positives once a real name is set): `` new RegExp(`\\b${escapeRegex(currentLabel)}\\b`, "g") `` → `${newName}`. Count as `indexMatches`.
5. Write each patched file via `.tmp` → `rename()` (existing `writeAtomic` in `src/storage.ts:58`).
6. Update `speakersRecord.speakerNames[speakerId] = newName`, write `speakers.json` the same atomic way.
7. Return per-file counts. 0 body matches across all `transcript*.md` is a warning (printed), not an error — the transcript may legitimately have zero sys entries for that speaker (e.g. renaming before they spoke). `escapeRegex` is imported from the new shared `src/regex-utils.ts`.

### CLI: `meet rename`

```
meet rename <meetingDir> <speakerId> <newName>
```

Example: `meet rename ~/Meetings/2026-07-23_14-30-standup "Speaker 1" "Женя"`.

Mirrors the existing `finalize <sessionDir>` argument convention (`src/cli.ts:69`) — explicit directory, no "latest meeting" magic (YAGNI; `meet list` already shows directories to copy-paste from).

On success, prints a per-file summary so the multi-file scope is explicit, e.g.:

```
renamed Speaker 1 → Женя: transcript.md (body 12, footer 1), transcript.parakeet.md (body 12), index.md (3)
```

### Testing
`src/speaker-rename.test.ts` — construct a temp dir with fixtures (matching real `rewriteMarkdown`/`speakers.json` output) and assert: label replaced in `transcript.md` body + Talk Time footer; **both** `transcript.md` and `transcript.parakeet.md` patched from a single call (parakeet footer correctly 0); `index.md` word-boundary patch counted separately; `speakerNames` persisted; unknown speaker id throws with the available-speakers list; missing `speakers.json` throws the "not a finalized meeting" message; `diarization.ok === false` throws the "no speakers" message; renaming twice re-targets the previously-applied name (not the stale canonical id).

---

## 3. F2 — Custom Vocabulary

### Problem
The call's vendor uses a "custom terms dictionary" to cut mis-transcription of rare names/jargon (targeting 96.7% → 98%). `meet` already has an analogous mechanism — `config.prompt` is passed as whisper's `--prompt` (`src/transcriber.ts:95`, `buildWhisperArgs`) — but it's one static string in `config.json`, not a project-level, hot-reloadable list. Editing it means hand-editing JSON config and restarting; there's no equivalent of `phrasebook.json`/`triggers.json` for vocabulary.

### Design
Structural clone of `src/triggers.ts` / `src/phrasebook.ts` (same mtime-hot-reload convention, same fail-open-to-identity-on-missing/invalid-file convention):

```ts
// src/vocabulary.ts
export const DEFAULT_VOCABULARY_PATH = resolve(import.meta.dirname, "..", "vocabulary.json");

export class Vocabulary {
  static load(path: string): Vocabulary          // missing/invalid JSON → empty (identity mode)
  maybeReload(): boolean                          // mtime check, same as Phrasebook/Triggers
  get terms(): string[]
  toPromptSuffix(basePrompt: string, maxTotalChars?: number): string  // "" when empty or when basePrompt alone meets budget; else ". Термины: a, b, c" sized so basePrompt + suffix ≤ maxTotalChars
}

export function getVocabulary(config: { vocabularyPath?: string; vocabularyReload?: boolean }): Vocabulary
```

`vocabulary.json` (project root, alongside `phrasebook.json`/`triggers.json`):
```json
{ "terms": ["Acme", "Smith", "ScreenCaptureKit"] }
```

### Integration point
`src/transcriber.ts:95`, inside `buildWhisperArgs`:

```ts
// before:
"--prompt", config.prompt,
// after:
"--prompt", config.prompt + getVocabulary(config).toPromptSuffix(config.prompt),
```

`toPromptSuffix(config.prompt)` budgets the **combined** string — `config.prompt` (~88 chars of Cyrillic, ~50-60 tokens) + suffix ≤ `maxTotalChars` (default 200). whisper's initial-prompt is a soft decoder bias with a shared token budget (~224 tokens); sizing only the suffix would let a long `config.prompt` plus a full suffix silently overflow. Simplest correct guard: join terms in file order, stop once `config.prompt + ". Термины: " + accumulated terms` would exceed `maxTotalChars` — no token counter needed (whisper truncates safely at a token boundary anyway); this keeps *our* contribution bounded and deterministic (first terms in the file win, same "first match wins" precedent as `triggers.ts`).

`buildWhisperArgs` is called for both live and final passes (`opts.pass`) — vocabulary applies to both, same as `config.prompt` does today. No signature change needed since `config` is already threaded through.

### Config additions (`src/types.ts`, mirroring `triggersPath`/`triggersReload`)
```ts
vocabularyPath: string;     // default: DEFAULT_VOCABULARY_PATH ("./vocabulary.json")
vocabularyReload: boolean;  // default: true
```

### Testing
`src/vocabulary.test.ts` — mirror `src/triggers.test.ts` structure: load valid file → terms present; missing file → empty/identity; malformed JSON → empty, no throw; `toPromptSuffix` truncates deterministically at the char budget; `maybeReload()` picks up mtime changes.

---

## 4. F3 — Action Items / Report Pass for Recordings

### Problem
`runOpencodeIndex()` (`src/opencode.ts:43`) already produces exactly what the call's "tasks" feature does — a `## Action Items` section (owner + deadline if inferable), plus Summary/Decisions/Topics/Tags — via `INDEX_PROMPT`. But it is **only wired into `src/import.ts:211`**, the `meet transcribe` batch-file path. A `meet start` recording that goes through `finalizeSession()` (`src/finalize.ts:289`) never calls it — live-recorded meetings get `transcript.md` + `speakers.json` but no `index.md`, no action items, no summary. That's the actual gap versus the vendor's "tasks" tab.

### Fix
Wire the existing function into `finalizeSession()`, at the same point the Parakeet A/B pass already hooks in (`src/finalize.ts:455`, right after `rewriteMarkdown()` + `appendPostFinalizeNote()`, inside the `entries.length > 0` block where `outputDir` is in scope). Wrap in an explicit `try/catch` — diarization and the Parakeet pass each fail open via their *own* internal try/catch; here we wrap externally (cleaner for a single call site). A failure here must never affect the transcript that was just written.

```ts
// src/finalize.ts, after the parakeetComparePass block:
if (config.opencodeIndexPass) {
  try {
    log("Generating index (opencode)...");
    const indexMarkdown = await runOpencodeIndex(config, session.outputFile, session.title);
    await writeAtomic(join(outputDir, "index.md"), indexMarkdown);
  } catch (err) {
    warn(`Index generation failed: ${err instanceof Error ? err.message : String(err)}, transcript unaffected`);
  }
}
```

No changes to `src/opencode.ts` — `runOpencodeIndex` already takes `(config, transcriptFile, title)` and is fully reusable as-is; the only thing missing was the call site.

### Config addition
```ts
opencodeIndexPass: boolean;  // default: false
```

Defaults to `false` (unlike `parakeetComparePass`, which defaults `true`) because it depends on an optional external CLI (`opencode`, already noted as optional in `src/cli.ts:321`'s doctor check) and adds real wall-clock time (`runOpencodeIndex` has a 180s timeout) to every recording's finalize — opt-in until the user confirms it's worth the wait. `meet doctor`'s existing opencode detection message can note this flag once added.

### Testing
Extend `src/finalize.test.ts` with a case mirroring the existing Parakeet-pass tests: mock/stub `runOpencodeIndex`, assert `index.md` is written when `opencodeIndexPass: true` and skipped when `false`; assert a thrown error from `runOpencodeIndex` is caught, logged as a warning, and `transcript.md`/`session.status` are unaffected.

---

## 5. Summary of file changes

| File | Change | Status |
|---|---|---|
| `src/regex-utils.ts` | **new** — shared `escapeRegex()` (extracted from the byte-identical private copies in `phrasebook.ts`/`attention.ts`) | ✅ done (`3cfbc77`) |
| `src/phrasebook.ts` | dedup: import `escapeRegex` from `regex-utils.ts`, drop private copy | ✅ done (`3cfbc77`) |
| `src/attention.ts` | dedup: import `escapeRegex` from `regex-utils.ts`, drop private copy | ✅ done (`3cfbc77`) |
| `src/speaker-rename.ts` | **new** — `renameSpeaker()` (uses shared `escapeRegex`) | ✅ done |
| `src/speaker-rename.test.ts` | **new** | ✅ done (11/11 pass) |
| `src/cli.ts` | add `rename <meetingDir> <speakerId> <newName>` command | ✅ done |
| `src/vocabulary.ts` | **new** — `Vocabulary`, `getVocabulary()`, structural clone of `triggers.ts` | ✅ done (`a02ddc4`) |
| `src/vocabulary.test.ts` | **new** | ✅ done (`a02ddc4`) |
| `src/transcriber.ts` | `buildWhisperArgs` (`:95`): `"--prompt", config.prompt + getVocabulary(config).toPromptSuffix(config.prompt)` | ✅ done (`a02ddc4`) |
| `src/finalize.ts` | add opencode-index step after the Parakeet A/B block (`:455`, inside `entries.length > 0`) | ✅ done (F3) |
| `src/finalize.test.ts` | add coverage for the new step | ⬜ skipped — no precedent for testing `finalizeSession()`'s wiring blocks (see F3 landed note) |
| `src/types.ts` | add `vocabularyPath`, `vocabularyReload`, `opencodeIndexPass` to `Config` + `DEFAULT_CONFIG` | ✅ done (`vocabularyPath`/`vocabularyReload` in `a02ddc4`; `opencodeIndexPass` in F3) |
| `vocabulary.json` | **new**, project root, empty `{ "terms": [] }` scaffold (same convention as `phrasebook.json`/`triggers.json`) | ✅ done (`a02ddc4`) |
| `src/cli.ts` (doctor) | note `opencodeIndexPass` state in the opencode detection line | ✅ done (F3) |
| `AGENTS.md` | document `speaker-rename.ts`, `regex-utils.ts`, `vocabulary.ts`, `opencodeIndexPass`, `meet rename` (primary agent doc) | ⬜ pending — file is already stale (missing `diarization.ts`/`talk-time.ts`/`parakeet-pass.ts` etc. from prior features too); out of scope for this spec, needs its own pass |

None of these touch Swift/native code — all three features are Node/TypeScript, operating on already-produced text and files.

---

## 6. Implementation order

One PR per feature, each independently mergeable. PR1's `regex-utils.ts` extraction is self-contained within PR1 (no cross-PR dependency).

| PR | Scope | Verify |
|---|---|---|
| **PR1** (F1) | `regex-utils.ts` + dedup `phrasebook.ts`/`attention.ts` → `speaker-rename.ts` + CLI `rename` + tests | ✅ landed — `npm run lint && npm run build && node --test` all green, 11/11 new tests, 383/383 total |
| **PR2** (F2) | `vocabulary.ts` (clone of `triggers.ts`) + `transcriber.ts` wiring + `types.ts` config + `vocabulary.json` scaffold + tests | ✅ landed (`a02ddc4`) — lint+build clean, 15/15 tests — `npm run lint && npm run build && node --test dist/vocabulary.test.js` |
| **PR3** (F3) | `types.ts` `opencodeIndexPass` + `finalize.ts` insertion (try/catch, `writeAtomic` index.md) + doctor msg | ✅ landed — `npm run lint && npm run build && node --test` all green, 383/383 total (no new test added, see landed note) |
