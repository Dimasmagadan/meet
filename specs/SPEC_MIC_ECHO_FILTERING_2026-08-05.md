# SPEC: Cross-Channel Audio Echo Filtering (Final Pass)

**Date:** 2026-08-05
**Status:** Done — Phase 0, Phase 1, and Phase 2 all landed (2026-08-05). Threshold calibration against real recordings (§6) remains open.
**Owner:** Dmitrii Diakonov

---

## 1. Problem

Recording without headphones, the other participant's voice plays through the speakers and leaks back into the mic. That leaked audio gets transcribed from the `mic-*.wav` channel and labeled **"Me"** in the transcript, even though the user never said it.

### Root cause A — text similarity is the wrong signal

`src/filters.ts::isDuplicate()` is supposed to catch exactly this: for each chunk index it compares the mic transcript against the simultaneous sys transcript (containment check, then Jaccard token similarity ≥ 0.75) and drops the mic side if they match. It fails often in practice because **whisper transcribes the same leaked audio differently on each channel** — the mic copy is degraded by the speaker → room → mic path (added/dropped words, different homophones), so the two transcripts of the *same* underlying audio don't score as similar text.

Measured on a real finalized meeting (`transcript.md`, whisper final pass already applied):

| # | mic text (abridged) | sys text (abridged) | Jaccard | caught? |
|---|---|---|---|---|
| 1 | "Всем привет. Мы хотели уточнить тебя по разделу мероприятия..." | "[Имя], привет. Здорово. Мы хотели уточнить у тебя по разделу мероприятия..." | 0.722 | **no** (just under 0.75) |
| 2 | "У нас он разделялась по правильным источникам. У нас есть мероприятие онлайн. Хаб сейчас приходит..." | "У нас есть мероприятие FUN, мероприятие онлайн. ХАП сейчас приходит..." | 0.464 | **no** |
| 3 | "Всё остальные мероприятия, они у нас идут сейчас в Битрикс..." | "Все остальные мероприятия. Они у нас сейчас идут в Битрикс..." | 0.786 | yes |
| 4 | "Сейчас разделения на онлайн-уфлайн в коде нет..." | "Или по какому-то другому и ты там передаешь отдельно." | 0.000 | no (genuinely distinct — correct) |

Lowering the Jaccard threshold is not a safe fix: real distinct utterances in a jargon-heavy meeting (shared words like "мероприятие", "источник") can also land in the 0.5–0.7 range, so a looser threshold trades missed echoes for wrongly-dropped genuine "Me" speech.

### Root cause B (new, found during review) — `mic-NNN` and `sys-NNN` are *not* the same time window

Both the existing text dedup and the proposed audio correlation assume chunk index N on the mic channel covers the same wall-clock window as chunk index N on the sys channel. **The capture code does not guarantee that**, and the misalignment grows monotonically through the meeting. Three independent sources, all in `native/AudioCapture`:

1. **Startup skew (constant).** `main.swift` starts `MicCapture` first, then builds the process tap + aggregate device + IOProc for `SystemAudioCapture` (`startTap()`). Chunk 1 opens for each writer at its own start moment, so `mic-001` begins ~0.5–2s *earlier* in wall-clock than `sys-001`. Constant for the session.

2. **Chunk-boundary overshoot (accumulates, per chunk).** `WAVWriter.appendSamplesIfNeeded()` appends the *whole* incoming buffer and only then checks `>= maxChunkSamples`, so every chunk overshoots 15s by up to one buffer. Mic buffers are 4096 hw frames (≈85ms after resampling to 16k), sys IOProc buffers are typically 512–1024 frames (≈10–20ms). Average overshoot differs by ~30–40ms **per chunk** → several seconds of relative drift over a one-hour meeting.

3. **Resampler sample loss (accumulates, per buffer).** `linearInterpolate()` in both capture classes computes `outputCount = Int(count / ratio)` and restarts `srcPos` at 0 for every buffer — the fractional remainder is dropped, never carried. Loss rate is `frac(count/ratio) / (count/ratio)`: ≈0.02% for the mic (4096@48k → 1365.33 → 1365), but ≈0.4% for sys with small IOProc buffers (512@48k → 170.67 → 170). Different loss rates on the two channels = another seconds-per-hour of relative drift, in the same direction as (2).

4. **Stall restarts (step offsets).** `recoverIfStalled()` / `restartCapture()` lose N seconds of audio while the writer keeps appending where it left off, shifting every later chunk of that channel by N seconds. Independent per channel.

Net effect: mic-N is *ahead of* (covers earlier audio than) sys-N, by an offset that starts at ~1s and grows to seconds over a long meeting. Row 2 of the table above is the signature of exactly this — the mic text carries a leading sentence ("У нас он разделялась по правильным источникам") that the sys channel had emitted in the *previous* chunk, which is what tanks the symmetric Jaccard to 0.464. So part of what was attributed to "whisper transcribes each channel differently" is actually window misalignment.

This also silently affects things outside this spec: `chunkToTimestamp()` assumes exactly `chunkDurationSeconds` per chunk, so transcript timestamps drift by the same amount, and diarization segment→entry mapping inherits it.

### Why the audio-level fix (VoiceProcessing IO / AEC) is off the table

`micVoiceProcessing` (`native/AudioCapture` VoiceProcessing IO, config key in `src/types.ts`) does true echo cancellation at the mic tap and was tried as the fix. **Rejected** — confirmed twice by the user (historically, commit `66399a0`; and again 2026-08-05) that enabling it makes the user's mic **quiet for the other call participants**, not just for our recording. It conflicts with the call app's (Zoom/Meet/etc.) own AEC/AGC on the same physical mic device — a live-call-quality regression, strictly worse than an occasional mislabeled transcript line. `micVoiceProcessing` stays `false` by default; see memory `meet-mic-voice-processing.md`.

---

## 2. Solution

Do echo detection **in post-processing only** — never touch the shared hardware input path the call app also uses, so live-call audio for other participants is untouched.

### 2.1 Review of the v1 proposal (what changed and why)

The original v1 ("windowed normalized cross-correlation of energy envelopes with a small max-lag search, drop mic when score ≥ THRESHOLD") is directionally right — audio is a far stronger signal than two independent whisper guesses — but it cannot be implemented as written:

| Issue | Why it breaks | Fix in this revision |
|---|---|---|
| **Max-lag search sized for "a few–tens of ms"** (speaker→mic acoustic delay) | Real offset is dominated by root cause B: ~1s at the start, growing to seconds. The correlation peak is outside the search window → score ≈ 0 → feature does nothing, or worse, locks onto a spurious peak. | Fix the drift at the source first (Phase 0), keep a wide lag search (±1 chunk) for the residual constant skew and stall steps. |
| **Chunk-level drop on a single correlation score** | High correlation says "this chunk *contains* echo", not "this chunk is *only* echo". A 15s chunk where the user talks over the far end still scores high → genuine "Me" speech is deleted. §6 of v1 flagged only the opposite (false-negative) direction. | Decide on `echoFraction` (share of *audible mic frames* explained by an aligned sys frame), not on raw correlation. Drop only when essentially all mic energy is explained. |
| **`isDuplicate()` signature change** | Would make the pure, well-tested text module depend on file I/O / sample buffers. | Keep `filters.ts` pure: add an optional `micEchoScore` field to `FinalChunkResult`, computed in `final-pass.ts` where the WAV paths already are. |
| **Interaction with the finalize safety net** | `finalize.ts:573` discards the *entire* final pass and reverts to the live (unfiltered, small-model) transcript when `entries.length < baseEntries.length`, and `baseEntries` is the non-silent set with **no dedup applied**. An echo filter that works well makes the final pass look "worse" and gets itself thrown away. | Must be addressed in the same change (see §3 Phase 2). |
| **Test plan uses `makeSineWav`** | A steady sine has a flat energy envelope; Pearson correlation on it is degenerate (zero variance) — the test would pass or divide-by-zero for the wrong reason. | Needs an amplitude-modulated (burst/silence) generator; see §5. |
| **No config gate discussion** | — | None needed: with headphones the mic simply doesn't contain sys audio, so the score self-gates to ~0. One tunable threshold in config, no on/off flag. |

### Phase 0 (prerequisite, Swift) — make `mic-NNN` and `sys-NNN` the same window

Root-cause fix for §1.B, ~20 lines, and it pays off beyond this spec (transcript timestamps, diarization mapping, existing text dedup):

- `WAVWriter.appendSamplesIfNeeded()` — split the incoming buffer at the remaining chunk capacity: write the head, keep the tail in a `carry` field, flush `carry` at the top of `startChunk()`. Callers unchanged. Chunks become exactly `chunkDurationSeconds × 16000` samples.
- `linearInterpolate()` (both `MicCapture` and `SystemAudioCapture`) — carry the fractional resampler phase and the previous buffer's last sample across calls instead of restarting `srcPos` at 0 per buffer. Removes the systematic per-buffer sample loss.
- Startup skew and stall steps are **not** fixed by this and don't need to be: they're constant / rare-step offsets that the lag search in Phase 2 absorbs.

Verification is cheap and doesn't need any new code — see §5 "Drift measurement".

### Phase 1 (cheap, text-only) — compare against the sys *neighbourhood*, asymmetrically

Even after Phase 0 the constant startup skew (~1s) remains, and every already-recorded meeting keeps its drift. Both are handled without touching audio:

- In `filterEntries()`, compare mic-N's tokens against the union of sys tokens from **N-1, N, N+1**.
- Replace symmetric Jaccard with asymmetric **coverage**: `|micTokens ∩ sysNeighbourhood| / |micTokens| ≥ 0.75`. Symmetric Jaccard is structurally wrong for this comparison — the sys side legitimately contains material the mic side doesn't (near-end-only speech, and now 3 chunks' worth), which drags the denominator up and hides real echoes. Coverage asks the actual question: "is everything the mic heard already present in what the speakers played?"
- Expected on the table above: row 1 (0.722 Jaccard, near-identical text) and row 2 (leading sentence lives in sys-N-1) both get caught; row 4 (coverage ≈ 0) stays. Row 3 stays caught.
- Risk: the widened window makes false positives cheaper too — a short genuine "Me" reply made of common words could be covered by 45s of sys text. The existing `micTokens.length <= 3` guard covers the shortest cases; calibrate on real meetings (§6) before raising the window beyond ±1.

Ship Phase 0 + Phase 1 first and re-measure. They are ~40 lines total and may well close the gap on their own.

### Phase 2 (audio gate) — only if Phase 1 still leaks

Compute a per-mic-chunk echo score directly from the waveforms, then use it as an additional OR-signal alongside the text check.

- **Envelope pass.** Stream every `mic-*.wav` / `sys-*.wav` once, producing per-source arrays of per-frame RMS at ~100ms frames (150 floats per 15s chunk; ~36k floats per source for a one-hour meeting — negligible memory, no sample retention). Concatenating per-source frames into one continuous timeline is what makes a cross-chunk lag search trivial.
- **Lag search.** For each mic chunk, maximise Pearson correlation `r` between the mic chunk's envelope and the sys timeline, over lag ∈ ±1 chunk (±150 frames). ~300 candidate lags × 150 frames = 45k multiply-adds per chunk — free next to whisper. Pearson (mean-subtracted, variance-normalised) makes the score scale-invariant, which matters because the echo is an attenuated copy.
- **Echo fraction, not correlation, is the drop criterion.** At the best lag: `echoFraction = (# mic frames above the mic speech threshold whose aligned sys frame is also above the sys speech threshold) / (# mic frames above the mic speech threshold)`. Drop the mic entry only when `r ≥ rMin` **and** `echoFraction ≥ fMin` (start conservative: `fMin ≈ 0.9`). A chunk where the user actually spoke has mic energy in frames where sys is silent → `echoFraction` falls → entry kept. This is what makes the gate safe against overlap, at the cost of keeping mixed chunks (which Layer 3 would handle).
- **Wiring.** `final-pass.ts` computes the scores (it already owns the WAV paths and the chunk loop) and sets `micEchoScore` on the `FinalChunkResult`; `filters.ts` stays a pure function of its inputs and just adds `if (mic.micEchoScore >= threshold) continue;` next to the existing text checks.
- **Safety net.** Track the count of entries dropped as echo in `runFinalPass` and either return it alongside the entries or exclude those chunk keys from the `baseEntries` comparison in `finalize.ts:573`, so effective filtering can't trigger the "keeping live" revert.

### Layer 3 (deferred, not in scope) — adaptive echo subtraction

Phases 1–2 only *detect and drop* chunks that are entirely echo. They can't help when the user talks **over** the other participant — real overlap needs subtraction, not gating. A follow-up could run an adaptive filter (NLMS) with the sys chunk as reference to subtract the estimated echo from the mic chunk before transcribing. Heavier (delay estimation + filter tuning) and only worth building if the conservative `echoFraction` gate leaves too many mixed chunks mislabeled. Explicitly deferred.

---

## 3. Scope

### Phase 0 (Swift, prerequisite)
- Exact chunk boundaries in `WAVWriter`; phase-carrying resampler in `MicCapture` / `SystemAudioCapture`.

### Phase 1 (ship with Phase 0)
- `filterEntries()` compares mic-N against sys-{N-1,N,N+1} using asymmetric coverage instead of symmetric Jaccard against sys-N.

### Phase 2 (only if still leaking after re-measurement)
- Envelope + lag search + `echoFraction` in `src/audio-metrics.ts`, wired through `FinalChunkResult.micEchoScore`.
- Fix the `finalize.ts` "keeping live" safety-net interaction.

### Non-goals
- No change to `micVoiceProcessing` / VoiceProcessing IO default — stays off (see §1).
- No live-pipeline changes — echo filtering remains a finalize-time concern, same as today's text dedup.
- No Layer 3 (adaptive subtraction).
- No change to the Parakeet A/B pass — it reuses F1 speaker labels and isn't in the dedup path.
- No new on/off config flag — the score self-gates when headphones are used. One threshold key for calibration only.
- Talk time is **not** fixed here: `computeTalkTime()` counts `storedRecords` (all non-silent chunks), not filtered entries, so "Me" stays inflated by echo-only chunks regardless of this work. Separate change, worth doing once `micEchoScore` exists.

---

## 4. Files touched (expected)

| File | Change |
|---|---|
| `native/AudioCapture/Sources/AudioCapture/WAVWriter.swift` | P0: split at chunk boundary, carry the tail |
| `native/AudioCapture/Sources/AudioCapture/MicCapture.swift` | P0: phase-carrying resampler |
| `native/AudioCapture/Sources/AudioCapture/SystemAudioCapture.swift` | P0: phase-carrying resampler |
| `src/filters.ts` | P1: neighbourhood + asymmetric coverage; P2: `micEchoScore` check (module stays pure) |
| `src/audio-metrics.ts` | P2: envelope extraction, lag search, `echoFraction` |
| `src/final-pass.ts` | P2: compute scores, set `micEchoScore` on results |
| `src/finalize.ts` | P2: don't let dropped-as-echo entries trip the "keeping live" revert |
| `src/filters.test.ts` | P1 + P2 cases |
| `src/audio-metrics.test.ts` | P2 unit tests on synthetic burst signals |

---

## 5. Testing

**Drift measurement (do this first — validates §1.B and calibrates the lag window):**
```bash
./native/AudioCapture/.build/release/AudioCapture --output-dir /tmp/drift --chunk-duration 15 --mode full
# play any audio through the speakers, talk occasionally, ^C after ~5 min
for p in mic sys; do
  echo "$p files=$(ls /tmp/drift/$p-*.wav | wc -l) bytes=$(cat /tmp/drift/$p-*.wav | wc -c)"
done
```
`bytes/2/16000` = recorded audio seconds per source. The gap between the two sources over the same wall-clock run **is** the accumulated relative drift; per-file byte counts above `chunkDuration × 16000 × 2 + 44` are the boundary overshoot. Re-run after Phase 0 — both should collapse to ~0.

**Automated:**
- P1 `filterEntries()`: mic text whose leading sentence lives in sys-N-1 → dropped (row 2); mic text about a genuinely different topic → kept (row 4); short common-word mic reply → still kept unless already covered by the `<= 3` token guard.
- P2 `audioSimilarity`/`echoFraction`: use an **amplitude-modulated** generator (bursts of noise separated by silence) — `makeSineWav`'s flat envelope has zero variance and makes Pearson degenerate. Cases: identical envelope → `r ≈ 1`, `echoFraction ≈ 1`; scaled + delayed copy (delay beyond the naive ±tens-of-ms window) → still found, proving the wide lag search; uncorrelated bursts → `r ≈ 0`; **mic = sys echo + extra bursts in sys-silent frames → high `r` but `echoFraction` below `fMin` → kept** (the overlap-safety case, the one that protects genuine "Me" speech).

**Manual:**
- Re-run `meet finalize` on a previously-recorded no-headphones meeting with known mislabeled "Me" lines and confirm those lines are filtered — and, just as important, that no genuine "Me" line disappeared and that the log doesn't say "keeping live".

---

## 6. Open questions / risks

- **Threshold calibration** — no labeled dataset yet, for either the P1 coverage threshold or the P2 `rMin`/`fMin`. Tune against a handful of real recordings, the way `micRmsThresholdDb`/`sysRmsThresholdDb` were tuned.
- **Phase 0 is not fully sufficient** — startup skew (~1s, constant) and stall-restart steps survive it. That's why P1 uses a ±1-chunk text window and P2 keeps a ±1-chunk lag search rather than the tens-of-ms window originally proposed.
- **Old meetings keep their drift** — Phase 0 only helps future recordings; re-finalizing an existing session still needs P1/P2 to absorb multi-second offsets.
- **Mixed chunks stay mislabeled by design** — the conservative `echoFraction` rule keeps any chunk containing genuine speech, so overlap-heavy meetings still show some echo text under "Me". That's the deliberate trade (a wrongly-deleted line is worse than a wrongly-attributed one); Layer 3 is the upgrade path.
- **Finalize safety net** — `finalize.ts:573` reverting the whole final pass when it yields fewer entries than the unfiltered base set is a pre-existing trap that gets sharper as the filter gets better. Must be handled in the same PR as P2, not after.
- **Compute cost** — one streaming pass over all WAVs plus ~45k MACs per chunk; negligible against whisper, but the envelope pass reads every chunk a second time, so keep it inside the existing `forEachAudibleChunk` traversal budget (`gateBudgetMs`, `system-monitor.ts`) rather than adding a separate full-directory pass.
