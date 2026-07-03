import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { readdir, rename, unlink, open } from "node:fs/promises";
import { join } from "node:path";
import type { Config, TranscriptEntry } from "./types.js";
import { resolveAnalysisBin } from "./storage.js";
import { makeWavHeader } from "./audio-metrics.js";

const SAMPLE_RATE = 16000;
const WAV_HEADER_SIZE = 44;

export interface DiarSegment {
  start: number;
  end: number;
  speaker: string;
}

export interface ChunkOffset {
  start: number;
  end: number;
}

// Concatenates sys-NNN.wav chunks (in index order) into a single WAV, streaming
// each chunk's PCM data section directly to disk. Returns an offset map giving
// each chunk's [start, end] position in the concatenated audio's timeline —
// missing indices are simply skipped, so gaps never desync later chunks.
export async function concatSysChunks(
  sessionDir: string,
): Promise<{ wavPath: string; offsets: Map<number, ChunkOffset> }> {
  const files = await readdir(sessionDir);
  const sysFiles = files
    .filter((f) => /^sys-\d{3}\.wav$/.test(f))
    .sort();

  const offsets = new Map<number, ChunkOffset>();
  const outPath = join(sessionDir, "sys-concat.wav");
  const tmpPath = `${outPath}.tmp`;

  let cursorSeconds = 0;
  let totalDataBytes = 0;

  const out = createWriteStream(tmpPath);
  // Placeholder header, rewritten with the final size once all data is copied.
  out.write(makeWavHeader(0, SAMPLE_RATE, 1, 16));

  try {
    for (const file of sysFiles) {
      const match = /^sys-(\d{3})\.wav$/.exec(file);
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

export async function runDiarizer(config: Config, wavPath: string): Promise<DiarSegment[]> {
  const bin = resolveAnalysisBin(config);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(bin, ["diarize", "--input", wavPath], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`AudioAnalysis diarize failed: ${err.message}${stderr ? ` (${stderr.trim()})` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });

  const parsed = JSON.parse(stdout) as { segments: DiarSegment[] };
  return parsed.segments;
}

export async function cleanupSysConcat(sessionDir: string): Promise<void> {
  await unlink(join(sessionDir, "sys-concat.wav")).catch(() => {});
}

// Renumbers raw diarizer speaker IDs ("1", "2", ...) to "Speaker 1", "Speaker 2",
// ... by first appearance in time across all segments.
function buildSpeakerLabelMap(segments: DiarSegment[]): Map<string, string> {
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const map = new Map<string, string>();
  for (const seg of sorted) {
    if (!map.has(seg.speaker)) {
      map.set(seg.speaker, `Speaker ${map.size + 1}`);
    }
  }
  return map;
}

// Replaces raw diarizer speaker IDs with their renumbered "Speaker N" labels.
// Idempotent: relabeling already-relabeled segments is a no-op.
export function relabelSegments(segments: DiarSegment[]): DiarSegment[] {
  const labelMap = buildSpeakerLabelMap(segments);
  return segments.map((s) => ({ ...s, speaker: labelMap.get(s.speaker)! }));
}

// Assigns a speaker label to each sys entry via majority time-overlap between
// the entry's chunk span (translated through `offsets`) and diarizer segments.
// Entries below `minOverlapRatio` of their chunk duration keep no label
// (renders as "Others"). Mic entries and entries for chunks missing from
// `offsets` (e.g. silence-gated) pass through unchanged.
export function assignSpeakers(
  entries: TranscriptEntry[],
  segments: DiarSegment[],
  offsets: Map<number, ChunkOffset>,
  minOverlapRatio: number = 0.3,
): TranscriptEntry[] {
  if (segments.length === 0) return entries;

  const labelMap = buildSpeakerLabelMap(segments);

  return entries.map((entry) => {
    if (entry.source !== "sys") return entry;
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
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = speaker;
      }
    }

    if (!bestSpeaker || bestOverlap / chunkDuration < minOverlapRatio) {
      return entry;
    }

    return { ...entry, speaker: labelMap.get(bestSpeaker) };
  });
}
