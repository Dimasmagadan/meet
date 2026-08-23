import { readFileSync, existsSync, renameSync } from "node:fs";
import { mkdir, appendFile, chmod, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import { expandPath } from "./storage.js";

// Producers of embeddings. Matching is backend-scoped: an identical voice
// extracted via a different clustering path (online DiarizerManager vs offline
// VBx) shifts the embedding distribution, so a fixed cosine threshold does not
// port across backends. Session WAVs are deleted at finalize, so the registry
// is the only surviving voice state — we never cross-match across backends.
export type SpeakerBackend = "diarizer-manager" | "vbx-offline";
export const EMBEDDING_DIMENSION = 256;

export function isValidEmbedding(value: unknown, requireNonZero = true): value is number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSION || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  return !requireNonZero || value.some((n) => n !== 0);
}

export interface RegistrySpeaker {
  id: string;                 // stable nanoid
  name: string | null;        // null until a user names them
  embedding: number[];        // 256-d, L2-normalized WeSpeaker
  backend: SpeakerBackend;
  quarantined?: boolean;      // set when a backend flip retires this entry (kept for audit, never matched)
  isSelf?: boolean;           // the recording user's own voiceprint (see matchSelf) — never carries a display name
  createdAt: string;          // ISO
  sourceMeetingId: string;    // first meeting that produced this voice
  matchCount: number;         // how many meetings matched it since creation
}

export interface SpeakerRegistry {
  version: 1;
  speakers: RegistrySpeaker[];
}

export interface AppliedSpeaker {
  globalSpeakerId: string;
  matchedName: string | null;  // the registry entry's name at match time
  score: number;               // best cosine (0 for a fresh registration with no prior entries)
  fresh: boolean;              // true when a new entry was created this meeting
}

export interface ApplyRegistryResult {
  labelOverrides: Map<string, string>;       // canonical "Speaker N" -> display name (only when a name exists)
  speakerMeta: Map<string, AppliedSpeaker>;  // canonical "Speaker N" -> meta
  matches: string[];                          // pre-formatted matches.log lines
}

export function emptyRegistry(): SpeakerRegistry {
  return { version: 1, speakers: [] };
}

// Missing/corrupt file -> empty registry (fail-open); finalize then registers
// every voice fresh. The registry is additive biometric state, never blocking.
// Per-entry validation drops hand-edited rows with non-array embeddings or a
// missing id — those would throw inside cosineSimilarity or break lookups; the
// finalize try/catch would absorb the throw, but filtering at load is cheaper
// and keeps `meet speakers list` working against a partially-corrupt file.
export function loadRegistry(path: string): SpeakerRegistry {
  const expanded = expandPath(path);
  try {
    if (!existsSync(expanded)) return emptyRegistry();
    const raw = readFileSync(expanded, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SpeakerRegistry>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.speakers)) {
      quarantineCorruptRegistry(expanded);
      return emptyRegistry();
    }
    const speakers = parsed.speakers.filter(
      (s): s is RegistrySpeaker =>
        !!s
        && typeof s.id === "string" && s.id.length > 0
         && isValidEmbedding(s.embedding)
         && (s.backend === "diarizer-manager" || s.backend === "vbx-offline"),
    );
    const invalid = parsed.speakers.length - speakers.length;
    if (invalid > 0) console.error(`[meet] speaker registry: skipped ${invalid} malformed embedding entr${invalid === 1 ? "y" : "ies"}`);
    return { version: 1, speakers };
  } catch {
    if (existsSync(expanded)) quarantineCorruptRegistry(expanded);
    return emptyRegistry();
  }
}

function quarantineCorruptRegistry(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`);
    console.error(`[meet] speaker registry: preserved corrupt file at ${path}.corrupt-*`);
  } catch {}
}

export async function saveRegistry(reg: SpeakerRegistry, path: string): Promise<void> {
  const expanded = expandPath(path);
  await mkdir(dirname(expanded), { recursive: true, mode: 0o700 });
  await chmod(dirname(expanded), 0o700);
  const tmp = `${expanded}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(reg, null, 2), { encoding: "utf-8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, expanded);
    await chmod(expanded, 0o600);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !isValidEmbedding(a) || !isValidEmbedding(b)) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Returns the nearest same-backend, non-quarantined entry whose cosine is >=
// threshold, else null. Backend-scoped per the S1<->S2 coupling rationale.
// `excludeIds` skips entries already consumed in the same run (see
// `applyRegistryToSpeakers`) — diarization asserts each "Speaker N" is a
// distinct person, so a same-run match would collapse two voices into one.
export function matchSpeaker(
  emb: number[],
  registry: SpeakerRegistry,
  threshold: number,
  backend: SpeakerBackend,
  excludeIds?: Set<string>,
): { speaker: RegistrySpeaker; score: number } | null {
  let best: RegistrySpeaker | null = null;
  let bestScore = -Infinity;
  for (const s of registry.speakers) {
    if (s.quarantined) continue;
    if (s.backend !== backend) continue;
    if (excludeIds && excludeIds.has(s.id)) continue;
    const score = cosineSimilarity(emb, s.embedding);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (best && bestScore >= threshold) return { speaker: best, score: bestScore };
  return null;
}

// Nearest isSelf entry whose cosine is >= threshold, else null. Used to split
// a mic-channel diarization cluster into "me" vs. "someone else" (a call that
// never went through this Mac lands entirely on the mic channel).
export function matchSelf(
  emb: number[],
  registry: SpeakerRegistry,
  threshold: number,
  backend: SpeakerBackend,
): { speaker: RegistrySpeaker; score: number } | null {
  let best: RegistrySpeaker | null = null;
  let bestScore = -Infinity;
  for (const s of registry.speakers) {
    if (s.quarantined || !s.isSelf || s.backend !== backend) continue;
    const score = cosineSimilarity(emb, s.embedding);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (best && bestScore >= threshold) return { speaker: best, score: bestScore };
  return null;
}

export function registerSpeaker(
  emb: number[],
  meetingId: string,
  registry: SpeakerRegistry,
  backend: SpeakerBackend,
  now: () => Date = () => new Date(),
  isSelf: boolean = false,
): RegistrySpeaker {
  if (!isValidEmbedding(emb)) throw new Error(`Embedding must be ${EMBEDDING_DIMENSION} finite non-zero values`);
  const speaker: RegistrySpeaker = {
    id: nanoid(12),
    name: null,
    embedding: emb,
    backend,
    createdAt: now().toISOString(),
    sourceMeetingId: meetingId,
    matchCount: 0,
    ...(isSelf ? { isSelf: true } : {}),
  };
  registry.speakers.push(speaker);
  return speaker;
}

// Matches (bumps matchCount, applies the entry's name if it has one) or
// registers each canonical "Speaker N" embedding fresh. Mutates `registry`
// in place. Pure w.r.t. disk — the caller loads/saves. Returns the display
// overrides + per-speaker meta to persist into speakers.json.
export function applyRegistryToSpeakers(
  embeddingsByLabel: Map<string, number[]>,
  meetingId: string,
  registry: SpeakerRegistry,
  threshold: number,
  backend: SpeakerBackend,
  now: () => Date = () => new Date(),
  // Pre-seeds claimedThisRun — e.g. the mic-diarization self/other split passes
  // the isSelf entry ids here so a non-self cluster can never be matched (or
  // audited as "nearest") against the recording user's own voiceprint.
  seedExcludeIds?: Set<string>,
): ApplyRegistryResult {
  const labelOverrides = new Map<string, string>();
  const speakerMeta = new Map<string, AppliedSpeaker>();
  const matches: string[] = [];
  const iso = now().toISOString();

  // Ids consumed this run — matches and fresh registrations both go in. Prevents
  // Speaker 2 from matching Speaker 1's just-registered entry, or two labels
  // both clearing threshold against one pre-existing entry (diarization already
  // asserts these are different people, so a same-run collision is wrong).
  const claimedThisRun = new Set<string>(seedExcludeIds ?? []);

  const candidates: Array<{ label: string; emb: number[]; speaker: RegistrySpeaker; score: number }> = [];
  for (const [label, emb] of embeddingsByLabel) {
    if (!isValidEmbedding(emb)) continue;
    for (const speaker of registry.speakers) {
      if (speaker.quarantined || speaker.backend !== backend || claimedThisRun.has(speaker.id)) continue;
      const score = cosineSimilarity(emb, speaker.embedding);
      if (score >= threshold) candidates.push({ label, emb, speaker, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.speaker.id.localeCompare(b.speaker.id));
  const matchesByLabel = new Map<string, { speaker: RegistrySpeaker; score: number }>();
  for (const candidate of candidates) {
    if (claimedThisRun.has(candidate.speaker.id) || matchesByLabel.has(candidate.label)) continue;
    claimedThisRun.add(candidate.speaker.id);
    matchesByLabel.set(candidate.label, candidate);
  }

  for (const [label, emb] of [...embeddingsByLabel].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (!isValidEmbedding(emb)) continue;
    const m = matchesByLabel.get(label);
    if (m) {
      claimedThisRun.add(m.speaker.id);
      m.speaker.matchCount += 1;
      if (m.speaker.name) labelOverrides.set(label, m.speaker.name);
      speakerMeta.set(label, {
        globalSpeakerId: m.speaker.id,
        matchedName: m.speaker.name,
        score: m.score,
        fresh: false,
      });
      matches.push(
        `${iso} ${meetingId} ${m.speaker.id} matched "${m.speaker.name ?? ""}" @ ${m.score.toFixed(4)} (threshold ${threshold})`,
      );
    } else {
      // Audit the nearest prior score even on a miss (0 when registry empty).
      // Same-run registrations are not "prior" — exclude them so the audit
      // reflects only pre-existing entries.
      let nearest = 0;
      for (const s of registry.speakers) {
        if (s.quarantined || s.backend !== backend) continue;
        if (claimedThisRun.has(s.id)) continue;
        nearest = Math.max(nearest, cosineSimilarity(emb, s.embedding));
      }
      const created = registerSpeaker(emb, meetingId, registry, backend, now);
      claimedThisRun.add(created.id);
      speakerMeta.set(label, {
        globalSpeakerId: created.id,
        matchedName: null,
        score: nearest,
        fresh: true,
      });
      matches.push(`${iso} ${meetingId} ${created.id} registered (unnamed) @ ${nearest.toFixed(4)}`);
    }
  }

  return { labelOverrides, speakerMeta, matches };
}

export function forgetSpeaker(registry: SpeakerRegistry, globalId: string): boolean {
  const idx = registry.speakers.findIndex((s) => s.id === globalId);
  if (idx === -1) return false;
  registry.speakers.splice(idx, 1);
  return true;
}

// Retires all entries of a backend (set on a backend flip) so they are kept for
// audit but never matched again. Returns the count quarantined.
export function quarantineByBackend(registry: SpeakerRegistry, backend: SpeakerBackend): number {
  let n = 0;
  for (const s of registry.speakers) {
    if (s.backend === backend && !s.quarantined) {
      s.quarantined = true;
      n++;
    }
  }
  return n;
}

export async function appendMatchesLog(path: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const expanded = expandPath(path);
  await mkdir(dirname(expanded), { recursive: true, mode: 0o700 });
  await chmod(dirname(expanded), 0o700);
  await appendFile(expanded, lines.map((l) => `${l}\n`).join(""), { encoding: "utf-8", mode: 0o600 });
  await chmod(expanded, 0o600);
}

// `matches.log` lives next to the registry file (default ~/.meet/speakers/).
export function matchesLogPath(registryPath: string): string {
  return join(dirname(expandPath(registryPath)), "matches.log");
}
