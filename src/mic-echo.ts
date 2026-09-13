import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, Session, TranscriptEntry } from "./types.js";
import type { ChunkOffset, DiarSegment } from "./diarization.js";
import { cleanupMicConcat, concatMicChunks } from "./diarization.js";
import { runEmbedder } from "./live-speakers.js";
import {
  cosineSimilarity,
  isValidEmbedding,
  loadRegistry,
  matchSelf,
  type SpeakerBackend,
  type SpeakerRegistry,
} from "./speaker-registry.js";
import { coverageRatio, isDuplicate, tokenize } from "./filters.js";

// Mic-channel echo attribution (finalize-time). Without a headset the remote
// party's voice plays through the speakers and leaks into the mic, where it is
// transcribed and labeled "Me". The P1/P2 echo filters
// (SPEC_MIC_ECHO_FILTERING_2026-08-05) only drop chunks that are *entirely*
// echo (text coverage / echoFraction); mixed chunks and whisper rendering
// mismatches keep the wrong label. This step voice-matches the surviving mic
// chunks against the per-speaker embeddings sys diarization already produced:
// a confident match to a remote speaker means the mic chunk carries that
// speaker's voice, not the user's — the entry is dropped when the sys text
// already covers the content, or relabeled "Me" -> "Speaker N" when it
// doesn't (the sys transcription missed or mangled that utterance).
//
// Strictly read-only against the speaker registry: echo-degraded voiceprints
// must never feed centroid updates or match counts (the sys side of the same
// meeting already did the registry work with clean embeddings).

const BACKEND: SpeakerBackend = "diarizer-manager";

// Chunk-level voiceprints compared against single-speaker centroids are
// degraded by the speaker -> room -> mic path, so the bar sits below
// speakerMatchThreshold (0.75) — same rationale as liveSpeakerMatchThreshold.
const AMBIGUITY_MARGIN = 0.05;

const EMPTY_REGISTRY: SpeakerRegistry = { version: 1, speakers: [] };

export interface MicEchoDecision {
  kind: "self" | "keep" | "remote";
  // Canonical "Speaker N" label, set only when kind === "remote".
  label?: string;
  score: number | null;
  runnerUp: number | null;
}

// Pure per-chunk decision: is this mic chunk the user ("self"/"keep") or a
// leaked remote speaker ("remote")? Self prints are checked first and win —
// the enrolled print was captured from clean mic audio and never carries a
// display name, so it can only describe the user.
export function attributeMicChunk(
  embedding: number[],
  speakerEmbeddings: Map<string, number[]>,
  registry: SpeakerRegistry,
  selfThreshold: number,
  matchThreshold: number,
): MicEchoDecision {
  const keep = (score: number | null, runnerUp: number | null): MicEchoDecision =>
    ({ kind: "keep", score, runnerUp });

  if (speakerEmbeddings.size === 0 || !isValidEmbedding(embedding)) return keep(null, null);

  if (matchSelf(embedding, registry, selfThreshold, BACKEND)) {
    return { kind: "self", score: null, runnerUp: null };
  }

  const ranked = [...speakerEmbeddings.entries()]
    .filter(([, centroid]) => isValidEmbedding(centroid))
    .map(([label, centroid]) => ({ label, score: cosineSimilarity(embedding, centroid) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, undefined, { numeric: true }));

  const best = ranked[0];
  if (!best) return keep(null, null);
  const second = ranked[1] ?? null;

  if (best.score < matchThreshold) return keep(best.score, second?.score ?? null);
  // Too close to call between two remote voices -> keep "Me". A wrong relabel
  // is worse than a missed one (mirrors the live labeler's guard).
  if (second && best.score - second.score < AMBIGUITY_MARGIN) {
    return keep(best.score, second.score);
  }
  return { kind: "remote", label: best.label, score: best.score, runnerUp: second?.score ?? null };
}

// "Did the sys channel already transcribe this content?" Reuses the P1
// filters' signals at the same thresholds: an exact/Jaccard duplicate against
// the same-index sys text, or the mic tokens covered by the sys
// {N-1,N,N+1} neighbourhood. If yes, the mic copy adds nothing — drop it;
// otherwise the mic text is the only copy of that utterance — relabel it.
export function hasSysCounterpart(
  micText: string,
  chunkIndex: number,
  sysTextByIndex: Map<number, string>,
  coverageThreshold: number,
): boolean {
  const sameIndex = sysTextByIndex.get(chunkIndex);
  if (sameIndex && isDuplicate(micText, sameIndex)) return true;

  const neighbourhood = new Set<string>();
  for (const n of [chunkIndex - 1, chunkIndex, chunkIndex + 1]) {
    const text = sysTextByIndex.get(n);
    if (text) for (const token of tokenize(text)) neighbourhood.add(token);
  }
  return coverageRatio(tokenize(micText), neighbourhood) >= coverageThreshold;
}

export interface MicEchoAttributionOutcome {
  entries: TranscriptEntry[];
  // Mic-concat-timeline segments for the Talk Time footer; empty unless at
  // least one chunk was attributed. Attributed chunks land under their
  // matched "Speaker N" (canonical — applyLabelOverridesToTalkTime patches
  // display names afterwards), every remaining audible mic chunk under "Me",
  // so computeTalkTime's micWasDiarized branch derives the "Me" row from
  // spans instead of the raw chunk count.
  micSegments: DiarSegment[];
  relabeled: number;
  dropped: number;
}

// Diarization-time counterpart of runMicDiarizationStep for the case it
// deliberately skips (sys diarization found speakers): attribute mic-channel
// echo into those speakers' label space. Mutates `speakersRecord` in place
// (segments/entryAssignments/micEchoAttribution diagnostics) so `meet rename`,
// `meet speakers suggest` and the parakeet A/B transcript see the attribution
// uniformly. Fails open: any error leaves entries unmodified.
export async function runMicEchoAttributionStep(
  session: Session,
  config: Config,
  entries: TranscriptEntry[],
  speakerEmbeddings: Map<string, number[]>,
  labelOverrides: Map<string, string>,
  // Mic chunk indices whose RMS envelope correlated with the sys neighbourhood
  // (final pass, P2) — acoustic evidence of speaker bleed. When the final pass
  // didn't run, null embeds every mic chunk with text instead. With headphones
  // the set is empty and the step costs nothing.
  echoCandidateIndices: Set<number> | null,
  storedRmsMap: Map<string, number>,
  speakersRecord: Record<string, unknown>,
  warn: (msg: string) => void,
  log: (msg: string) => void,
): Promise<MicEchoAttributionOutcome> {
  const none: MicEchoAttributionOutcome = { entries, micSegments: [], relabeled: 0, dropped: 0 };

  if (!config.micEchoAttribution) return none;
  if (speakerEmbeddings.size === 0) return none;

  const sysTextByIndex = new Map<number, string>();
  for (const e of entries) {
    if (e.source === "sys" && e.text) sysTextByIndex.set(e.chunkIndex, e.text);
  }

  const candidates = entries.filter((e) => {
    if (e.source !== "mic" || !e.text) return false;
    if (echoCandidateIndices && !echoCandidateIndices.has(e.chunkIndex)) return false;
    return existsSync(join(session.sessionDir, `mic-${String(e.chunkIndex).padStart(3, "0")}.wav`));
  });
  if (candidates.length === 0) return none;

  const registry: SpeakerRegistry = config.speakerRegistryEnabled
    ? loadRegistry(config.speakerRegistryPath)
    : EMPTY_REGISTRY;

  // chunkIndex -> canonical "Speaker N" for every remote match (both actions).
  const attributed = new Map<number, string>();
  const decisions: Array<Record<string, unknown>> = [];
  let embedFailed = 0;

  for (const entry of candidates) {
    const wavPath = join(session.sessionDir, `mic-${String(entry.chunkIndex).padStart(3, "0")}.wav`);
    let embedding: number[] = [];
    try {
      embedding = await runEmbedder(config, wavPath);
    } catch {
      embedFailed += 1;
      continue;
    }
    const decision = attributeMicChunk(
      embedding,
      speakerEmbeddings,
      registry,
      config.speakerMatchThreshold,
      config.micEchoMatchThreshold,
    );
    decisions.push({
      chunkIndex: entry.chunkIndex,
      kind: decision.kind,
      label: decision.label ?? null,
      score: decision.score,
      runnerUp: decision.runnerUp,
    });
    if (decision.kind === "remote" && decision.label) {
      attributed.set(entry.chunkIndex, decision.label);
    }
  }

  // Calibration data lands in speakers.json even when nothing matched.
  speakersRecord.micEchoAttribution = {
    threshold: config.micEchoMatchThreshold,
    decisions,
  };

  if (embedFailed > 0) {
    warn(`Mic echo attribution: ${embedFailed} embed call(s) failed, those chunks kept as "Me"`);
  }
  if (attributed.size === 0) return none;

  const relabels = new Map<number, string>();
  const drops = new Set<number>();
  for (const [chunkIndex, label] of attributed) {
    const entry = candidates.find((e) => e.chunkIndex === chunkIndex);
    if (entry && hasSysCounterpart(entry.text, chunkIndex, sysTextByIndex, config.micEchoCoverageThreshold)) {
      drops.add(chunkIndex);
    } else {
      relabels.set(chunkIndex, label);
    }
  }

  const outEntries = entries
    .filter((e) => !(e.source === "mic" && drops.has(e.chunkIndex)))
    .map((e) => {
      if (e.source !== "mic") return e;
      const label = relabels.get(e.chunkIndex);
      return label ? { ...e, speaker: labelOverrides.get(label) ?? label } : e;
    });

  let micSegments: DiarSegment[] = [];
  try {
    const { offsets } = await concatMicChunks(session.sessionDir);
    try {
      // Chunks the final pass transcribed but the live queue never recorded
      // (default quit path drains via pipeline.close()) have no entries.jsonl
      // RMS record — the transcript text proves they were audible, so count
      // them as "Me" time instead of silence.
      const textIndices = new Set(
        entries.filter((e) => e.source === "mic" && e.text).map((e) => e.chunkIndex),
      );
      micSegments = buildMicSegments(offsets, attributed, storedRmsMap, textIndices, config.micRmsThresholdDb);
    } finally {
      await cleanupMicConcat(session.sessionDir);
    }
  } catch (err) {
    warn(`Mic echo attribution: talk-time segment build failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Same bookkeeping shape runMicDiarizationStep writes for the mic-only path.
  const existingAssignments = (speakersRecord.entryAssignments as
    | Array<{ source?: "mic" | "sys"; chunkIndex: number; speaker: string | null }>
    | undefined) ?? [];
  speakersRecord.entryAssignments = [
    ...existingAssignments.filter((a) => a.source !== "mic"),
    ...outEntries
      .filter((e) => e.source === "mic" && e.speaker)
      .map((e) => ({ source: e.source, chunkIndex: e.chunkIndex, speaker: e.speaker! })),
  ];
  const recordedSegments = speakersRecord.segments as DiarSegment[] | undefined;
  if (Array.isArray(recordedSegments) && micSegments.length > 0) {
    speakersRecord.segments = [...recordedSegments, ...micSegments];
  }
  speakersRecord.micEchoAttribution = {
    threshold: config.micEchoMatchThreshold,
    attributed: attributed.size,
    relabeled: relabels.size,
    dropped: drops.size,
    decisions,
  };

  log(`Mic echo attribution: ${attributed.size} mic chunk(s) voice-matched a remote speaker (${relabels.size} relabeled, ${drops.size} dropped as echo-covered)`);

  return { entries: outEntries, micSegments, relabeled: relabels.size, dropped: drops.size };
}

function buildMicSegments(
  offsets: Map<number, ChunkOffset>,
  attributed: Map<number, string>,
  storedRmsMap: Map<string, number>,
  micTextIndices: Set<number>,
  micRmsThresholdDb: number,
): DiarSegment[] {
  const segments: DiarSegment[] = [];
  for (const [index, range] of offsets) {
    const label = attributed.get(index);
    if (!label) {
      const rmsDb = storedRmsMap.get(`mic-${String(index).padStart(3, "0")}`);
      // No stored record → let the transcript text decide (final-pass-only
      // chunks have no entries.jsonl record but were still audible).
      const audible = rmsDb !== undefined ? rmsDb >= micRmsThresholdDb : micTextIndices.has(index);
      if (!audible) continue;
    }
    segments.push({ start: range.start, end: range.end, speaker: label ?? "Me" });
  }
  return segments;
}
