import type { EntryRecord } from "./types.js";
import type { DiarSegment } from "./diarization.js";

export interface TalkTimeStats {
  totalSeconds: number;
  speakers: Array<{ label: string; seconds: number; percent: number }>;
}

export interface ComputeTalkTimeParams {
  entryRecords: EntryRecord[];
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
): number {
  const count = entryRecords.filter((r) => r.source === source && r.rmsDb >= thresholdDb).length;
  return count * chunkDurationSeconds;
}

function speakerSortKey(label: string): number {
  const m = /^Speaker (\d+)$/.exec(label);
  return m ? parseInt(m[1], 10) : Infinity;
}

export function computeTalkTime(params: ComputeTalkTimeParams): TalkTimeStats {
  const { entryRecords, chunkDurationSeconds, micRmsThresholdDb, sysRmsThresholdDb, diarSegments } = params;

  const meSeconds = activeChunkSeconds(entryRecords, "mic", micRmsThresholdDb, chunkDurationSeconds);

  const rows: Array<{ label: string; seconds: number }> = [{ label: "Me", seconds: meSeconds }];

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
    const othersSeconds = activeChunkSeconds(entryRecords, "sys", sysRmsThresholdDb, chunkDurationSeconds);
    rows.push({ label: "Others", seconds: othersSeconds });
  }

  const totalSeconds = rows.reduce((sum, r) => sum + r.seconds, 0);
  const speakers = rows.map((r) => ({
    ...r,
    percent: totalSeconds > 0 ? Math.round((r.seconds / totalSeconds) * 100) : 0,
  }));

  return { totalSeconds, speakers };
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function formatTalkTimeSection(stats: TalkTimeStats): string {
  const lines = ["## Talk Time", ""];
  for (const speaker of stats.speakers) {
    lines.push(`- ${speaker.label}: ${formatDuration(speaker.seconds)} (${speaker.percent}%)`);
  }
  return lines.join("\n") + "\n";
}
