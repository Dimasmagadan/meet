import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rename, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import type { Config, TranscriptEntry } from "./types.js";
import { resolveAnalysisBin } from "./storage.js";
import { makeWavHeader } from "./audio-metrics.js";
import { applyQoS } from "./process-priority.js";
import { chunkFileRegex, sortChunkFilenames } from "./regex-utils.js";
import { isValidEmbedding } from "./speaker-registry.js";

const SAMPLE_RATE = 16000;
const WAV_HEADER_SIZE = 44;

export interface DiarSegment {
  start: number;
  end: number;
  speaker: string;
}

export interface DiarizeResult {
  segments: DiarSegment[];
  // Raw speaker id ("1", "2", ...) -> 256-d L2-normalized WeSpeaker embedding.
  // Emitted by DiarizeCommand.swift for segment-backed speakers only; absent
  // (empty) on older Swift builds, so always optional here.
  embeddings: Record<string, number[]>;
}

export interface ChunkOffset {
  start: number;
  end: number;
}

function canonicalSpeakerNumber(label: string): number {
  return Number(/^Speaker (\d+)$/.exec(label)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

// Concatenates <prefix>-NNN.wav chunks (in index order) into a single WAV,
// streaming each chunk's PCM data section directly to disk. Returns an offset
// map giving each chunk's [start, end] position in the concatenated audio's
// timeline — missing indices are simply skipped, so gaps never desync later
// chunks. Shared by concatSysChunks and concatMicChunks.
async function concatChunksImpl(
  sessionDir: string,
  prefix: "sys" | "mic",
  outName: string,
): Promise<{ wavPath: string; offsets: Map<number, ChunkOffset> }> {
  const files = await readdir(sessionDir);
  const chunkFiles = sortChunkFilenames(files.filter((f) => chunkFileRegex(prefix).test(f)));

  const offsets = new Map<number, ChunkOffset>();
  const outPath = join(sessionDir, outName);
  const tmpPath = `${outPath}.tmp`;

  let cursorSeconds = 0;
  let totalDataBytes = 0;

  const out = createWriteStream(tmpPath);
  // Placeholder header, rewritten with the final size once all data is copied.
  out.write(makeWavHeader(0, SAMPLE_RATE, 1, 16));

  const indexRe = chunkFileRegex(prefix, true);
  try {
    for (const file of chunkFiles) {
      const match = indexRe.exec(file);
      if (!match) continue;
      const index = parseInt(match[1], 10);
      const filePath = join(sessionDir, file);

      const dataBytes = await copyWavData(filePath, out);
      if (dataBytes <= 0) continue;

      const durationSeconds = dataBytes / 2 / SAMPLE_RATE;
      offsets.set(index, { start: cursorSeconds, end: cursorSeconds + durationSeconds });
      cursorSeconds += durationSeconds;
      totalDataBytes += dataBytes;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }

  // Patch the header in place with the real data size now that it's known.
  const header = makeWavHeader(totalDataBytes, SAMPLE_RATE, 1, 16);
  await patchHeader(tmpPath, header);
  await rename(tmpPath, outPath);

  return { wavPath: outPath, offsets };
}

export async function concatSysChunks(
  sessionDir: string,
): Promise<{ wavPath: string; offsets: Map<number, ChunkOffset> }> {
  return concatChunksImpl(sessionDir, "sys", "sys-concat.wav");
}

// Mic-channel counterpart, used when sys diarization found nobody (a call
// that never went through this Mac lands entirely on the mic channel) — see
// runMicDiarizationStep in finalize.ts.
export async function concatMicChunks(
  sessionDir: string,
): Promise<{ wavPath: string; offsets: Map<number, ChunkOffset> }> {
  return concatChunksImpl(sessionDir, "mic", "mic-concat.wav");
}

async function copyWavData(filePath: string, out: NodeJS.WritableStream): Promise<number> {
  const header = Buffer.alloc(WAV_HEADER_SIZE);
  const fh = await open(filePath, "r");
  try {
    const { bytesRead } = await fh.read(header, 0, WAV_HEADER_SIZE, 0);
    if (bytesRead < WAV_HEADER_SIZE) return 0;
    const dataSize = header.readUInt32LE(40);
    if (dataSize <= 0) return 0;

    await new Promise<void>((resolve, reject) => {
      const src = createReadStream(filePath, { start: WAV_HEADER_SIZE, end: WAV_HEADER_SIZE + dataSize - 1 });
      src.on("error", reject);
      src.on("end", resolve);
      src.pipe(out, { end: false });
    });

    return dataSize;
  } finally {
    await fh.close();
  }
}

async function patchHeader(filePath: string, header: Buffer): Promise<void> {
  const fh = await open(filePath, "r+");
  try {
    await fh.write(header, 0, header.length, 0);
  } finally {
    await fh.close();
  }
}

export async function runDiarizer(config: Config, wavPath: string, opts?: { offline?: boolean }): Promise<DiarizeResult> {
  const bin = resolveAnalysisBin(config);
  const flags = opts?.offline ? ["--offline"] : [];
  const { command, args } = applyQoS(bin, ["diarize", "--input", wavPath, ...flags], config);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`AudioAnalysis diarize failed: ${err.message}${stderr ? ` (${stderr.trim()})` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });

  return parseDiarizeOutput(stdout);
}

// Parses the AudioAnalysis `diarize` JSON stdout. Pure — unit-tested against a
// captured payload to pin the Swift->Node contract (segments + embeddings)
// without running the Swift binary. Backward-compatible: a payload without
// `embeddings` (older Swift builds) yields an empty embeddings map.
export function parseDiarizeOutput(stdout: string): DiarizeResult {
  const parsed = JSON.parse(stdout) as { segments?: DiarSegment[]; embeddings?: Record<string, number[]> };
  return {
    segments: Array.isArray(parsed.segments) ? parsed.segments : [],
    embeddings: Object.fromEntries(Object.entries(parsed.embeddings ?? {}).filter(([, value]) => isValidEmbedding(value))),
  };
}

export async function cleanupSysConcat(sessionDir: string): Promise<void> {
  await unlink(join(sessionDir, "sys-concat.wav")).catch(() => {});
}

export async function cleanupMicConcat(sessionDir: string): Promise<void> {
  await unlink(join(sessionDir, "mic-concat.wav")).catch(() => {});
}

// Renumbers raw diarizer speaker IDs ("1", "2", ...) to "Speaker 1", "Speaker 2",
// ... by first appearance in time across all segments. Exported so the registry
// can map raw embedding keys to their relabeled canonical "Speaker N" labels.
export function buildSpeakerLabelMap(segments: DiarSegment[]): Map<string, string> {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.speaker.localeCompare(b.speaker, undefined, { numeric: true }));
  const map = new Map<string, string>();
  for (const seg of sorted) {
    if (!map.has(seg.speaker)) {
      map.set(seg.speaker, `Speaker ${map.size + 1}`);
    }
  }
  return map;
}

// Maps raw diarizer embeddings ("1" -> vector) to their renumbered canonical
// "Speaker N" labels, dropping raw ids that never made it into a segment
// (see the phantom-identity note in DiarizeCommand.swift) or carry an empty
// vector. Shared by the registry match step (S1) and the A/B pass (S2).
export function buildEmbeddingsByLabel(
  segments: DiarSegment[],
  embeddings: Record<string, number[]>,
): Map<string, number[]> {
  const rawToLabel = buildSpeakerLabelMap(segments);
  const byLabel = new Map<string, number[]>();
  for (const [rawId, emb] of Object.entries(embeddings)) {
    const label = rawToLabel.get(rawId);
    if (label && Array.isArray(emb) && emb.length > 0) byLabel.set(label, emb);
  }
  return byLabel;
}

// Replaces raw diarizer speaker IDs with their renumbered "Speaker N" labels.
// Idempotent: relabeling already-relabeled segments is a no-op.
export function relabelSegments(segments: DiarSegment[]): DiarSegment[] {
  if (segments.every((segment) => /^Speaker \d+$/.test(segment.speaker))) return segments.map((segment) => ({ ...segment }));
  const labelMap = buildSpeakerLabelMap(segments);
  return segments.map((s) => ({ ...s, speaker: labelMap.get(s.speaker)! }));
}

// Shared overlap-scoring loop for `source`-channel entries: majority
// time-overlap between the entry's chunk span (translated through `offsets`)
// and diarizer segments, resolved to a display label via `resolveLabel`.
// Entries below `minOverlapRatio` of their chunk duration keep no label.
// Entries on the other channel and entries for chunks missing from `offsets`
// (e.g. silence-gated) pass through unchanged.
function assignSpeakersCore(
  entries: TranscriptEntry[],
  segments: DiarSegment[],
  offsets: Map<number, ChunkOffset>,
  minOverlapRatio: number,
  source: "mic" | "sys",
  resolveLabel: (rawSpeaker: string) => string | undefined,
): TranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.source !== source) return entry;
    const chunkRange = offsets.get(entry.chunkIndex);
    if (!chunkRange) return entry;

    const chunkDuration = chunkRange.end - chunkRange.start;
    if (chunkDuration <= 0) return entry;

    const overlapBySpeaker = new Map<string, number>();
    for (const seg of segments) {
      const overlap = Math.min(chunkRange.end, seg.end) - Math.max(chunkRange.start, seg.start);
      if (overlap <= 0) continue;
      overlapBySpeaker.set(seg.speaker, (overlapBySpeaker.get(seg.speaker) ?? 0) + overlap);
    }

    let bestSpeaker: string | null = null;
    let bestOverlap = 0;
    for (const [speaker, overlap] of overlapBySpeaker) {
      if (overlap > bestOverlap || (overlap === bestOverlap && bestSpeaker !== null && canonicalSpeakerNumber(speaker) < canonicalSpeakerNumber(bestSpeaker))) {
        bestOverlap = overlap;
        bestSpeaker = speaker;
      }
    }

    if (!bestSpeaker || bestOverlap / chunkDuration < minOverlapRatio) {
      return entry;
    }

    const label = resolveLabel(bestSpeaker);
    return label ? { ...entry, speaker: label } : entry;
  });
}

// Assigns a speaker label to each sys entry, deriving canonical "Speaker N"
// labels itself from raw diarizer ids via buildSpeakerLabelMap.
export function assignSpeakers(
  entries: TranscriptEntry[],
  segments: DiarSegment[],
  offsets: Map<number, ChunkOffset>,
  minOverlapRatio: number = 0.3,
): TranscriptEntry[] {
  if (segments.length === 0) return entries;
  const labelMap = buildSpeakerLabelMap(segments);
  return assignSpeakersCore(entries, segments, offsets, minOverlapRatio, "sys", (raw) => labelMap.get(raw));
}

// Mic-channel counterpart for the self/other split (runMicDiarizationStep in
// finalize.ts): `segments` already carry their final label ("Me" or
// "Speaker N", assigned by the caller from a self-voiceprint match) — used
// as-is instead of re-derived, since buildSpeakerLabelMap would treat "Me" as
// a fresh raw id and renumber everything from scratch.
export function assignLabeledSpeakers(
  entries: TranscriptEntry[],
  segments: DiarSegment[],
  offsets: Map<number, ChunkOffset>,
  minOverlapRatio: number = 0.3,
): TranscriptEntry[] {
  if (segments.length === 0) return entries;
  return assignSpeakersCore(entries, segments, offsets, minOverlapRatio, "mic", (raw) => raw);
}
