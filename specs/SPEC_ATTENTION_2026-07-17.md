# SDD Spec: Attention Alerts (Live Trigger-Word Detection)

**Date:** 2026-07-17
**Status:** Draft — approved direction, pending implementation
**Owner:** Dmitrii Diakonov

---

## 1. Overview

During calls the user is sometimes distracted and misses being addressed by name. Watch the **live** transcription of other participants for user-defined trigger words and interrupt the user's attention when one appears.

| # | Feature | Outcome |
|---|---------|---------|
| F1 | Trigger-word detection + macOS notification | Case-insensitive substring match on sys-channel live text against `~/.meet/triggers.json`; on match, `osascript` notification with sound, trigger name, and phrase snippet |
| F2 | Terminal recap | The last ~3 minutes of transcript (mic + sys, merged, timestamped) printed as a delimited banner in the terminal running `meet start` |

### Goals
- Never block or slow the live transcription loop — detection is a thin, synchronous check on already-produced text; notification is fire-and-forget.
- Fail-open everywhere: missing/invalid triggers file, osascript failure, or denied notification permission degrade to today's behavior with at most a warn-once.
- Sys-channel only: the user's own mic speech is never matched.
- Alert machinery generic enough that a future pause detector can feed it.

### Non-goals (v1)
- **No awkward-pause detection** ("someone asked, nobody answers"). Explicitly deferred: with 15s chunks, chunk-granularity silence detection reacts 15–30s late; a useful version needs the Swift capture binary to emit sub-chunk RMS level events (~1s cadence). The extension point is designed in: `AttentionAlert.kind` is a discriminated union (`"trigger"` today, `"pause"` later) and the cooldown map is keyed per kind.
- No fuzzy/phonetic matching — substring stems («Дим») cover Russian inflections well enough.
- No mic-channel matching.
- No alert history persistence.

### Accepted constraint: latency
15s chunks + the sequential whisper queue mean a trigger word is detected ~15–45s after it was spoken. The alert therefore shows the **speech-time** timestamp (from `chunkToTimestamp`), and its value is "catch up now", not "react instantly".

---

## 2. Architecture

### 2.1 Hook point

`Recorder.initPipeline()` transcribe callback (`src/recorder.ts:77-98`). Rationale:

- Text arriving there is already `cleanText`-ed and phrasebook-applied (transcriber.ts) — the exact text we want to match.
- Recorder is exclusively the live `meet start` UX and owns stdout; pipeline is also driven by finalize/import paths where alerts would be wrong.
- **Ordering guarantee (verified):** `pipeline.ts` executes `results.set(...)` and `processedChunks.push(...)` *before* invoking `onTranscribed`, so the triggering chunk is already visible to `entriesFromSession(session, results)` at callback time. `entries.jsonl` is appended *after* the callback — do not use it as the recap source.
- No callback signature change needed: `(source, index, text)` is sufficient.

Glue (~12 lines), after the existing `if (!text) return;` guard and after `appendEntry`:

```ts
if (source === "sys" && !this.shuttingDown && !this.paused) {
  const alert = this.attention.check(index, text);   // null when disabled / no match / cooldown
  if (alert) {
    const entries = entriesFromSession(this.session, this.pipeline.getResults());
    process.stdout.write("\n");                      // break the \r status line (health-warning pattern)
    console.log(formatRecap(alert, buildRecap(entries, index, alert.windowChunks)));
    sendMacNotification(alert).catch((err) => this.warn("notification failed", err));
  }
}
```

### 2.2 New module: `src/triggers.ts`

Structural clone of `src/phrasebook.ts` (class + mtime `maybeReload()` + module singleton + `expandPath`):

```ts
export interface TriggerMatch { trigger: string; snippet: string }

export class Triggers {
  static load(path: string): Triggers        // missing/invalid JSON → empty set (identity mode, no warnings)
  match(text: string): TriggerMatch | null   // case-insensitive substring; first match wins
  maybeReload(): boolean                     // mtime check, same as Phrasebook.maybeReload
  get triggerCount(): number
}

export function getTriggers(config: { triggersPath?: string; triggersReload?: boolean }): Triggers
```

- Substring (not word-boundary) so Russian stems catch inflected forms: «Дим» matches «Диму», «Димой». JS `toLowerCase()` handles Cyrillic.
- Non-string/empty entries skipped; lowered forms precomputed at load.
- `snippet`: ~40 chars either side of the match from the original-case text, ellipsized — used in the notification body.

### 2.3 New module: `src/attention.ts`

```ts
export type AttentionAlert = {
  kind: "trigger";                 // future: | "pause"
  trigger: string;
  snippet: string;
  timestamp: string;               // chunkToTimestamp of the matched chunk (speech time)
  chunkIndex: number;
  windowChunks: number;
};

export class AttentionMonitor {
  constructor(session: { chunkDurationSeconds: number; startedAt: string },
              deps?: { now?: () => number; loadConfig?: () => Config });
  check(chunkIndex: number, text: string): AttentionAlert | null;
}

export function buildRecap(entries: TranscriptEntry[], alertChunkIndex: number, windowChunks: number): TranscriptEntry[];
export function formatRecap(alert: AttentionAlert, entries: TranscriptEntry[]): string;
export function buildNotificationArgs(alert: AttentionAlert, sound: string): string[];  // pure, testable
export function sendMacNotification(alert: AttentionAlert, sound?: string): Promise<void>;
```

- `check()` reloads config per call (precedent: pipeline reloads config per chunk — sync `readFileSync`, one call per 15s) → live pickup of the enable flag and cooldown. Order: enabled? → `getTriggers(config)` (mtime hot-reload) → `match(text)` → cooldown gate.
- Cooldown: `Map<AttentionAlert["kind"], number>` of last-alert timestamps — per-kind so a future pause alert cools down independently. Injectable `now()` for tests.
- `windowChunks = Math.ceil(attentionRecapSeconds / chunkDurationSeconds)` (180/15 = 12 per source at defaults).
- `buildRecap`: filter `entriesFromSession` output (already merged mic+sys, timestamped, sorted) to `chunkIndex >= alertChunkIndex - windowChunks`.
- `formatRecap`: chalk-colored banner, matched line highlighted, trailing newline so the 5s `\r` status line resumes cleanly:

```
════════════════════════════════════════════════════════
  ⚡ ATTENTION [14:03:30] — trigger «Дим» matched
  "…слушай, Дим, что ты думаешь про…"
────────────────────────────────────────────────────────
  [14:00:45] Me:     ...
  [14:01:00] Others: ...
  [14:03:30] Others: …слушай, Дим, …
════════════════════════════════════ end recap (last 3m)
```

### 2.4 Notification: injection-safe osascript

Never interpolate transcript text into AppleScript source. Pass it as argv via the `on run argv` form — text is data, never parsed:

```ts
execFile("osascript", [
  "-e", "on run argv",
  "-e", "display notification (item 1 of argv) with title (item 2 of argv) sound name (item 3 of argv)",
  "-e", "end run",
  message,             // «Дим» + snippet, truncated ~150 chars, control chars stripped
  "meet — attention",
  sound,               // config.attentionSound
], { timeout: 10_000 }, cb)
```

`execFile` (never a shell) matches the existing whisper/opencode spawn pattern. Failures go through warn-once and never block the loop.

### 2.5 Config (`src/types.ts`: `Config` + `DEFAULT_CONFIG`)

| Key | Default | Purpose |
|-----|---------|---------|
| `attentionAlerts` | `true` | master switch (no triggers file ⇒ no-op, so `true` is safe) |
| `triggersPath` | `"~/.meet/triggers.json"` | trigger file location |
| `triggersReload` | `true` | mtime hot-reload, mirrors `phrasebookReload` |
| `attentionCooldownSeconds` | `60` | min seconds between alerts (per alert kind) |
| `attentionRecapSeconds` | `180` | recap window printed to terminal |
| `attentionSound` | `"Glass"` | macOS notification sound name |

### 2.6 Trigger file schema (`~/.meet/triggers.json`, untracked)

```json
{
  "triggers": ["Дим", "Dmitr", "Дмитрий"]
}
```

Missing file / invalid JSON / empty array → identity mode, silent (phrasebook convention).

---

## 3. Feature specs

### F1: Trigger detection + notification
- Runs only for `source === "sys"`, non-empty cleaned text, not during shutdown drain or pause.
- Matching happens on **post-cleanText, post-phrasebook** text — triggers must be written in the form the phrasebook produces (documented in README).
- Multiple triggers matching, or one trigger matching repeatedly within a chunk → first match wins; finer granularity is pointless under the cooldown.
- Notification: title `meet — attention`, body `«trigger» — "…snippet…"`, sound `attentionSound`.

### F2: Terminal recap
- Source of truth: in-memory `pipeline.getResults()` via `entriesFromSession` — not `transcript.md`, not `entries.jsonl`.
- Window: last `attentionRecapSeconds` (default 180s ≈ 12 chunks/source), including the triggering chunk.
- Rendering: plain terminal text (no markdown bold), `Me:`/`Others:` labels, `[HH:MM:SS]` speech-time timestamps, matched line highlighted.

### `meet doctor` addition
Print trigger status (`triggers: 3 loaded from ~/.meet/triggers.json` / `attention alerts: disabled`) and fire one test notification with the hint: "If no banner appeared, allow notifications for your terminal app in System Settings → Notifications."

---

## 4. Implementation plan

1. This spec.
2. `src/types.ts` — 6 config keys + defaults.
3. `src/triggers.ts` + `src/triggers.test.ts`.
4. `src/attention.ts` + `src/attention.test.ts`.
5. `src/recorder.ts` — `attention` field + callback glue.
6. `src/cli.ts` — doctor additions.
7. Docs: CLAUDE.md (Module Breakdown + flow diagram + config table), AGENTS.md, PLAN.md, README.md ("Attention alerts" section: triggers.json example, config keys, notification-permission note).
8. `npm run build && npm test`.

---

## 5. Testing

**`src/triggers.test.ts`** (clone phrasebook.test.ts tmpdir conventions): identity on missing/invalid/empty file; case-insensitive Cyrillic match («дим» matches «Диму сказали»); stem mid-word match; snippet ellipsis at edges and text boundaries; non-string entries skipped; first-of-several wins; `maybeReload` mtime semantics (unchanged / touched / deleted).

**`src/attention.test.ts`** (fake `now()` + fake `loadConfig`; never spawns osascript): disabled flag → null; no match → null; cooldown (within 60s → null, after → alert, keyed per kind); `windowChunks` math; `buildRecap` window filtering + merged order + includes triggering chunk; `formatRecap` banner delimiters, highlight, labels; `buildNotificationArgs` argv shape — text containing `"` `\` and newlines passes intact (argv needs no escaping), truncation applied.

**Manual verification (no real meeting):**
1. `~/.meet/triggers.json` = `{"triggers": ["Дим"]}`.
2. `meet doctor` → trigger status line + test notification.
3. Start `meet start`; in another terminal synthesize a spoken sys chunk and drop it into the active session dir (chokidar picks up any `sys-NNN.wav`):
   ```
   say -v Milena -o /tmp/t.aiff "Дима, ты с нами? Что скажешь?"
   afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/t.aiff /tmp/sys-099.wav
   cp /tmp/sys-099.wav ~/.meet/sessions/meet-*/
   ```
   Expect within ~10s: notification + recap banner. Repeat within 60s → suppressed (cooldown). Edit triggers.json mid-session → next chunk uses new triggers. A `mic-099.wav` copy must NOT alert.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| AppleScript injection via transcript text | argv-passing (`on run argv`); `execFile`, never a shell |
| Terminal app lacks notification permission | doctor test notification + README note; warn-once, never fatal |
| Whisper hallucination contains a trigger | `cleanText` hallucination filters run first; 60s cooldown caps blast radius |
| Phrasebook rewrites the name before matching | Documented: triggers written in post-phrasebook form |
| User's own voice echoed on sys channel | Rare (needs speaker loopback); cooldown caps it; accepted v1 |
| Repeated matches in one chunk / burst of chunks | First match per chunk + per-kind cooldown |
| Empty/silence-gated chunks | Existing `if (!text) return;` guard fires before the check |
| Alert during shutdown drain / pause | `shuttingDown` / `paused` guards in the glue |
| Detection latency (~15–45s behind speech) | Inherent to chunked transcription; alert shows speech-time timestamp |
| Recap corrupting the `\r` status line | Leading `\n` + trailing newline (health-warning pattern) |

---

## 7. Open questions (defaults chosen)

- Match the mic channel too (e.g. catch action items the user said)? **No** — sys-only (chosen).
- Persist alerts to a file for post-meeting review? **Deferred.**
- Pause detection via Swift sub-chunk RMS events? **Deferred** — revisit after v1 proves the alert UX; `kind: "pause"` + per-kind cooldown are the ready extension points.
