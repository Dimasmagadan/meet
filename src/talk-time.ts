import type { EntryRecord } from "./types.js";
import type { DiarSegment } from "./diarization.js";

export interface TalkTimeStats {
  totalSeconds: number;
  speakers: Array<{ label: string; seconds: number; percent: number }>;
}

export interface ComputeTalkTimeParams {
  entryRecords: EntryRecord[];
  // Keys ("${source}-${paddedIndex}") of chunks whose text survived to the
  // final transcript. The default quit paths (q/Ctrl-C/auto-stop) drain via
  // pipeline.close() rather than stop(), so the final pass is the only
  // witness that those chunks were audible — entries.jsonl has no record for
  // them and the raw chunk count would undercount talk time. Same signal
  // mic-echo.ts uses for its own fallback.
  textChunkKeys?: Set<string>;
  chunkDurationSeconds: number;
  micRmsThresholdDb: number;
  sysRmsThresholdDb: number;
  // Relabeled ("Speaker 1", ...) diarization segments; empty when diarization
  // is disabled or failed, in which case sys talk time falls back to the same
  // chunk-counting method used for mic, reported as a single "Others" row.
  diarSegments: DiarSegment[];
}

function activeChunkSeconds(
  entryRecords: EntryRecord[],
  source: "mic" | "sys",
  thresholdDb: number,
  chunkDurationSeconds: number,
  textChunkKeys?: Set<string>,
): number {
  // Union, not sum: a chunk can have both a stored RMS record and surviving
  // transcript text and must count once.
  const counted = new Set<string>();
  for (const r of entryRecords) {
    if (r.source === source && r.rmsDb >= thresholdDb) {
      counted.add(`${r.source}-${String(r.index).padStart(3, "0")}`);
    }
  }
  if (textChunkKeys) {
    for (const key of textChunkKeys) {
      if (key.startsWith(`${source}-`)) counted.add(key);
    }
  }
  return counted.size * chunkDurationSeconds;
}

// Sort order for speaker rows/lists: "Me" first, then Speaker 1..N, then
// anything else. speaker-rename.ts shares this for its "available speakers"
// error listing.
export function speakerSortKey(label: string): number {
  if (label === "Me") return -1;
  const m = /^Speaker (\d+)$/.exec(label);
  return m ? parseInt(m[1], 10) : Infinity;
}

export function computeTalkTime(params: ComputeTalkTimeParams): TalkTimeStats {
  const { entryRecords, textChunkKeys, chunkDurationSeconds, micRmsThresholdDb, sysRmsThresholdDb, diarSegments } = params;

  // Mic-diarization (runMicDiarizationStep) already produced a diarization-derived
  // "Me" row among diarSegments when it split the mic channel into self/other —
  // using that instead of the raw chunk count avoids counting the other party's
  // mic time as "Me".
  const micWasDiarized = diarSegments.some((s) => s.speaker === "Me");
  const rows: Array<{ label: string; seconds: number }> = micWasDiarized
    ? []
    : [{ label: "Me", seconds: activeChunkSeconds(entryRecords, "mic", micRmsThresholdDb, chunkDurationSeconds, textChunkKeys) }];

  if (diarSegments.length > 0) {
    const bySpeaker = new Map<string, number>();
    for (const seg of diarSegments) {
      const duration = Math.max(0, seg.end - seg.start);
      bySpeaker.set(seg.speaker, (bySpeaker.get(seg.speaker) ?? 0) + duration);
    }
    const speakerRows = [...bySpeaker.entries()]
      .map(([label, seconds]) => ({ label, seconds }))
      .sort((a, b) => speakerSortKey(a.label) - speakerSortKey(b.label));
    rows.push(...speakerRows);
  } else {
    const othersSeconds = activeChunkSeconds(entryRecords, "sys", sysRmsThresholdDb, chunkDurationSeconds, textChunkKeys);
    rows.push({ label: "Others", seconds: othersSeconds });
  }

  const totalSeconds = rows.reduce((sum, r) => sum + r.seconds, 0);
  const speakers = rows.map((r) => ({
    ...r,
    percent: totalSeconds > 0 ? Math.round((r.seconds / totalSeconds) * 100) : 0,
  }));

  return { totalSeconds, speakers };
}

export function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function formatTalkTimeSection(stats: TalkTimeStats): string {
  const lines = ["## Talk Time", ""];
  for (const speaker of stats.speakers) {
    lines.push(`- ${speaker.label}: ${formatDuration(speaker.seconds)} (${speaker.percent}%)`);
  }
  return lines.join("\n") + "\n";
}
