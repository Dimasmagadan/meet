# SPEC: Mic-Channel Echo Attribution (Finalize)

**Date:** 2026-09-11
**Status:** Done — landed same day.
**Owner:** Dmitrii Diakonov
**Builds on:** `SPEC_MIC_ECHO_FILTERING_2026-08-05.md` (Phases 0–2)

---

## 1. Problem

Without a headset, the remote party's voice plays through the laptop speakers and leaks into the mic. That leaked audio gets transcribed from `mic-*.wav` and labeled **"Me"** even though the user never said it.

The 2026-08-05 echo work (Phase 0 drift fix, Phase 1 asymmetric text coverage, Phase 2 `echoFraction` audio gate) only **drops chunks that are entirely echo**. It still misses, by design and in practice:

1. **Mixed chunks** — any chunk where the user also spoke has `echoFraction < 0.9` and is kept whole under "Me".
2. **Whisper rendering mismatches** — the mic copy of the same audio transcribes differently than the sys copy; text coverage below the 0.75 threshold slips through.
3. **No relabeling** — the filter vocabulary has no way to say "this mic audio is Speaker 2's voice": it can only keep or drop a whole chunk. `runMicDiarizationStep` (`finalize.ts`) can split the mic channel, but deliberately refuses when sys diarization already found speakers (`if (sysSegmentCount > 0) return none;`), on the assumption that "mic already correctly holds only the user in that case" — exactly the assumption a no-headset call breaks.

AEC at capture (VoiceProcessing IO) remains rejected — enabling it makes the user's mic quiet for the other call participants (confirmed twice, see the 2026-08-05 spec §1).

## 2. Solution

Attribute mic-channel echo **into the sys speakers' label space** at finalize. After `runDiarizationStep` produces canonical `Speaker N` labels and per-speaker embeddings (`buildEmbeddingsByLabel`), the new `runMicEchoAttributionStep` (`src/mic-echo.ts`):

1. **Selects candidates** — mic entries with text whose WAV is still on disk. When the final pass ran, only chunks whose RMS envelope already correlated with the sys neighbourhood count (`FinalPassResult.echoCorrelatedMicIndices`, the P2 correlation gate, transcription-independent): with headphones that set is empty and the step costs nothing. Without the final pass, all mic-with-text chunks are candidates.
2. **Embeds** each candidate with `AudioAnalysis embed` (~0.3 s ANE per chunk, same primitive as the live labeler).
3. **Decides** per chunk (`attributeMicChunk`, pure):
   - an enrolled self print (`isSelf`, backend-scoped `diarizer-manager`) that matches at `speakerMatchThreshold` wins → the chunk stays "Me";
   - otherwise the best cosine against the sys speaker centroids: below `micEchoMatchThreshold` (0.7, below the 0.75 finalize threshold for the same reason as `liveSpeakerMatchThreshold`) or leading the runner-up by less than `AMBIGUITY_MARGIN` (0.05) → stays "Me";
   - a confident, unambiguous match → the chunk carries that remote speaker's voice.
4. **Acts** on confident matches:
   - the sys text already covers the content (`isDuplicate` same-index or the P1 asymmetric coverage over the sys {N-1,N,N+1} neighbourhood, same thresholds as the existing filter) → **drop** the mic entry as echo;
   - otherwise the mic text is the only copy of the utterance → **relabel** `Me` → `Speaker N` (display-name overrides from the registry are applied, mirroring the sys path).
5. **Aligns Talk Time** — when anything was attributed, the step builds mic-concat-timeline segments (attributed chunks under their matched `Speaker N`, remaining audible mic chunks under `Me`); `computeTalkTime`'s `micWasDiarized` branch then derives the "Me" row from spans instead of the raw chunk count, so the footer matches the relabeled body. Canonical labels only; `applyLabelOverridesToTalkTime` patches names afterwards.
6. **Persists bookkeeping** — `speakersRecord.entryAssignments` gains mic rows (source-keyed, so parakeet A/B now labels relabeled mic chunks too), `speakersRecord.segments` gains the mic segments, and `speakersRecord.micEchoAttribution` stores the threshold plus per-chunk decisions (`kind`/`label`/`score`/`runnerUp`) as calibration data even when nothing matched.

Properties: fail-open everywhere (embed failure or any error → chunk stays "Me", warning only); read-only against the speaker registry (echo-degraded voiceprints must never feed centroid EMA or match counts — the sys side already did the registry work with clean embeddings); works without a self print (threshold + margin carry the risk), stronger with one (`meet speakers enroll-self`).

The old "second numbering space" objection for splitting mic under sys diarization dissolves: mic chunks map into the existing sys labels rather than minting new ones.

## 3. Scope

- `src/mic-echo.ts` (new) — pure decision core + orchestration.
- `src/finalize.ts` — `DiarizationOutcome.embeddingsByLabel`; step wired after `runMicDiarizationStep`; talk-time segment merge.
- `src/final-pass.ts` — `FinalPassResult.echoCorrelatedMicIndices` (the acoustic candidate set).
- `src/parakeet-pass.ts` — speaker labels applied to mic chunks from `speakerByChunk` (was sys-only).
- `src/types.ts` — `micEchoAttribution: true`, `micEchoMatchThreshold: 0.7`.
- Docs: README (features + config), `docs/features.md` + `docs/ru/features.md` (speaker-identification + config-reference markers).
- Tests: `src/mic-echo.test.ts` (core + orchestration against a fake `AudioAnalysis` emitting one-hot embeddings).

## Non-goals

- No live-pipeline change — the live transcript still labels mic as "Me"; attribution is finalize-time. A live variant would need a self print for safe attribution and is deferred.
- No change to `micVoiceProcessing` (stays off) or to the P1/P2 filters — attribution complements them; their drops still gate the finalize safety net as before, and this step runs after that net.
- Talk-time for chunks dropped by the *existing* P1/P2 filters still counts as "Me" (the 2026-08-05 spec's separate-change note stands; this step only aligns its own attributions).
- No registry mutations from this step.

## 4. Testing

- Unit: `attributeMicChunk` (no speakers / invalid embedding / clear match / below threshold / ambiguity margin / self-print precedence) and `hasSysCounterpart` (same-index duplicate, drift case, distinct text) on one-hot 256-d basis vectors, so thresholds and margins are exact.
- Orchestration: fake `AudioAnalysis` shell emitting chunk-keyed one-hot embeddings — relabel-without-counterpart, drop-with-counterpart, keep-no-match, headphones fast path (empty correlated set), missing-WAV no-op, disabled flag, and the enrolled-self print keeping the user's chunk under "Me"; `micSegments`/`entryAssignments`/`segments`/`micEchoAttribution` shapes asserted.
- Full suite green (666 tests).

## 5. Open questions / risks

- **Threshold calibration** — `micEchoMatchThreshold` 0.7 is a reasoned starting point (echo-degraded prints score below clean ones), not a measured one. The per-chunk cosine diagnostics in `speakers.json` (`micEchoAttribution.decisions`) exist exactly for this: re-finalize a real no-headset meeting and tune against the score distribution.
- **Mixed chunks key on the dominant voice** — a chunk where the user talks over the far end is attributed to whichever voice dominates the embedding; overlapped user speech is not preserved under "Me" when the far end dominates. Self-print matching bounds the reverse error.
- **No self print → residual false-relabel risk** if the user's voice genuinely resembles a remote speaker's; the margin guard and the 0.7 threshold are the only protection then. Enrolling (`meet speakers enroll-self`) is the recommended mitigation.
- **Final-pass dependency for the cheap path** — without `finalRetranscribe` there is no correlated-candidate set, so every mic-with-text chunk gets embedded (~0.3 s each); correct but slower.
