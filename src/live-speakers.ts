import { execFile } from "node:child_process";
import type { Config } from "./types.js";
import { resolveAnalysisBin } from "./storage.js";
import { applyQoS } from "./process-priority.js";
import {
  AMBIGUITY_MARGIN,
  isValidEmbedding,
  loadRegistry,
  matchSelf,
  centroidsOf,
  cosineSimilarity,
  type SpeakerRegistry,
  type SpeakerBackend,
} from "./speaker-registry.js";

// Live per-chunk speaker identification (read-only against the cross-session
// registry). Every finalized sys chunk (or mic chunk in --mic mode) gets a
// cheap WeSpeaker voiceprint (`AudioAnalysis embed`, ~0.3s ANE); this module
// turns it into a transcript label without ever mutating the registry —
// enrollment stays finalize-only so mixed/noisy chunk vectors cannot pollute
// the persistent voiceprints.
//
// Chunk-level embeddings sit slightly lower against whole-meeting pooled
// centroids than pooled-vs-pooled comparisons, hence the dedicated (lower)
// liveSpeakerMatchThreshold instead of speakerMatchThreshold. When the best
// candidate leads the runner-up by less than AMBIGUITY_MARGIN the chunk is
// treated as inconclusive and the caller keeps the fallback label ("Others").

const LIVE_BACKEND: SpeakerBackend = "diarizer-manager";

// Below-threshold-but-close: a chunk scoring at least this against exactly
// one identity borrows that identity's session number instead of minting a
// new one (chunk quality fluctuates around the threshold).
const NEAR_ANCHOR_PORCH = 0.65;

export interface LiveIdentification {
  speaker: string; // display label for the transcript entry
  matchedName: string | null;
  score: number;
  globalSpeakerId: string | null; // null for session-local (unregistered) voices
}

interface Candidate {
  key: string;
  score: number;
  name: string | null;
  globalId: string | null; // registry row id, null for local voices
}

export function parseEmbedOutput(stdout: string): { embedding: number[] } {
  const parsed = JSON.parse(stdout) as { embedding?: number[] };
  return { embedding: Array.isArray(parsed.embedding) ? parsed.embedding : [] };
}

// Spawns `AudioAnalysis embed` for one chunk WAV. Fail-open by contract: the
// caller treats any rejection as "no live label this chunk".
export async function runEmbedder(config: Config, wavPath: string): Promise<number[]> {
  const bin = resolveAnalysisBin(config);
  const { command, args } = applyQoS(bin, ["embed", "--input", wavPath], config);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`AudioAnalysis embed failed: ${err.message}${stderr ? ` (${stderr.trim()})` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
  return parseEmbedOutput(stdout).embedding;
}

export class LiveSpeakerLabeler {
  private readonly registry: SpeakerRegistry;
  private readonly threshold: number;
  // Stable per-session numbering: identity key -> "Speaker N". Registry-backed
  // identities use `person:{globalId}` so near-threshold chunks borrow the
  // same number as confident ones; unknown voices get their own `voice:N`.
  private readonly sessionNumbers = new Map<string, string>();
  // Voices with no plausible registry row file a session-local print so the
  // next chunk of the same unknown person reuses their number instead of
  // minting a new one per chunk. Never persisted anywhere.
  private readonly localVoices: Array<{ key: string; centroid: number[] }> = [];
  private localSeq = 0;
  private nextNumber = 0;

  constructor(registry: SpeakerRegistry, threshold: number) {
    this.registry = registry;
    this.threshold = threshold;
  }

  // Top-2 across both pools (registry rows via max-centroid cosine, session
  // local prints), deterministic on ties by key.
  private rankAgainst(emb: number[], excludeKeys: Set<string>): { best: Candidate; second: Candidate | null } | null {
    const scored: Candidate[] = [];
    for (const s of this.registry.speakers) {
      if (s.quarantined || s.backend !== LIVE_BACKEND || excludeKeys.has(s.id)) continue;
      let best = -Infinity;
      for (const c of centroidsOf(s)) {
        const score = cosineSimilarity(emb, c);
        if (score > best) best = score;
      }
      scored.push({ key: s.id, score: best, name: s.name, globalId: s.id });
    }
    for (const v of this.localVoices) {
      if (excludeKeys.has(v.key)) continue;
      scored.push({ key: v.key, score: cosineSimilarity(emb, v.centroid), name: null, globalId: null });
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    return { best: scored[0], second: scored[1] ?? null };
  }

  private assignNumber(key: string): string {
    const existing = this.sessionNumbers.get(key);
    if (existing) return existing;
    this.nextNumber += 1;
    const label = `Speaker ${this.nextNumber}`;
    this.sessionNumbers.set(key, label);
    return label;
  }

  private identityKey(candidate: Candidate): string {
    return candidate.globalId ? `person:${candidate.globalId}` : candidate.key;
  }

  private fileLocalVoice(emb: number[]): string {
    const key = `voice:${this.localSeq++}`;
    this.localVoices.push({ key, centroid: [...emb] });
    return key;
  }

  // Mic-channel self check: a confident isSelf hit renders as "Me". No margin
  // guard — the enrolled self-print is compared only against other isSelf
  // entries, a pool the user controls explicitly.
  private matchMicSelf(emb: number[]): Candidate | null {
    const m = matchSelf(emb, this.registry, this.threshold, LIVE_BACKEND);
    return m ? { key: m.speaker.id, score: m.score, name: "Me", globalId: m.speaker.id } : null;
  }

  identify(source: "mic" | "sys", rawEmbedding: number[]): LiveIdentification | null {
    if (!isValidEmbedding(rawEmbedding)) return null;
    const emb = rawEmbedding;

    if (source === "mic") {
      const self = this.matchMicSelf(emb);
      if (self) return { speaker: "Me", matchedName: "Me", score: self.score, globalSpeakerId: self.globalId };
    }

    const ranked = this.rankAgainst(emb, new Set());
    const best = ranked?.best ?? null;
    const second = ranked?.second ?? null;
    const marginOk = !second || !best || best.score - second.score >= AMBIGUITY_MARGIN;

    if (best && marginOk && best.score >= this.threshold) {
      if (best.name) {
        return { speaker: best.name, matchedName: best.name, score: best.score, globalSpeakerId: best.globalId };
      }
      return { speaker: this.assignNumber(this.identityKey(best)), matchedName: null, score: best.score, globalSpeakerId: best.globalId };
    }

    // Below threshold but hugging exactly one identity: borrow its session
    // number so labeling stays stable while chunk quality fluctuates around
    // the threshold (mixed-speaker chunks usually score low and land here).
    if (best && marginOk && best.score >= NEAR_ANCHOR_PORCH) {
      return { speaker: this.assignNumber(this.identityKey(best)), matchedName: null, score: best.score, globalSpeakerId: null };
    }

    if (marginOk) {
      // Weak match (nothing hugged closely enough): file a fresh session-local
      // print. Later chunks of the same unknown voice usually clear the
      // threshold against this print (tier 1 includes locals) and keep its
      // number; truly degraded sequences mint extra numbers rather than risk
      // collapsing distinct strangers. Ambiguous vectors stay unlabeled.
      const key = this.fileLocalVoice(emb);
      return { speaker: this.assignNumber(key), matchedName: null, score: best?.score ?? 0, globalSpeakerId: null };
    }

    return null;
  }
}

// Factory honoring the config gates. Returns null whenever live labels are
// disabled — callers skip the embed spawn entirely in that case.
export function createLiveSpeakerLabeler(config: Config): LiveSpeakerLabeler | null {
  if (!config.speakerRegistryEnabled || !config.liveSpeakerLabels) return null;
  try {
    const registry = loadRegistry(config.speakerRegistryPath);
    return new LiveSpeakerLabeler(registry, config.liveSpeakerMatchThreshold);
  } catch {
    return null;
  }
}
