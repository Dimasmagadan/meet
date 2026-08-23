import { appendFile, writeFile } from "node:fs/promises";
import type { TranscriptEntry, Session } from "./types.js";
import type { TalkTimeStats } from "./talk-time.js";
import { formatTalkTimeSection } from "./talk-time.js";

export function chunkToTimestamp(chunkIndex: number, chunkDurationSeconds: number, startedAt: string): string {
  const start = new Date(startedAt);
  const offsetMs = (chunkIndex - 1) * chunkDurationSeconds * 1000;
  const time = new Date(start.getTime() + offsetMs);
  const h = String(time.getHours()).padStart(2, "0");
  const m = String(time.getMinutes()).padStart(2, "0");
  const s = String(time.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function entriesFromSession(session: Session, results: Map<string, string>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const chunk of session.processedChunks) {
    if (chunk.status !== "done") continue;
    const key = `${chunk.source}-${String(chunk.index).padStart(3, "0")}`;
    const text = results.get(key) || "";
    if (!text) continue;
    const timestamp = chunkToTimestamp(chunk.index, session.chunkDurationSeconds, session.startedAt);
    entries.push({ source: chunk.source, chunkIndex: chunk.index, timestamp, text, ...(chunk.speaker ? { speaker: chunk.speaker } : {}) });
  }

  entries.sort((a, b) => {
    if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
    return a.source === "mic" ? -1 : 1;
  });

  return entries;
}

function formatEntry(entry: TranscriptEntry): string {
  if (entry.source === "file") {
    return `**[${entry.timestamp}]** ${entry.text}\n`;
  }
  // Mic entries default to "Me", but runMicDiarizationStep (finalize.ts) can
  // assign a real speaker label when the mic channel held more than one voice
  // (a call that never went through this Mac) — entry.speaker wins when set.
  const label = entry.speaker ?? (entry.source === "mic" ? "Me" : "Others");
  return `**[${entry.timestamp}] ${label}:** ${entry.text}\n`;
}

export function makeHeader(title: string, startedAt: string): string {
  const date = new Date(startedAt);
  const dateStr = date.toLocaleDateString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit" });
  const timeStr = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `# ${title} — ${dateStr} ${timeStr}\n\n`;
}

export async function appendEntry(filePath: string, entry: TranscriptEntry): Promise<void> {
  const line = formatEntry(entry);
  await appendFile(filePath, line);
}

export function assembleMarkdown(title: string, startedAt: string, entries: TranscriptEntry[], talkTime?: TalkTimeStats): string {
  const lines: string[] = [makeHeader(title, startedAt)];

  for (const entry of entries) {
    lines.push(formatEntry(entry));
  }

  if (talkTime) {
    lines.push("\n" + formatTalkTimeSection(talkTime));
  }

  return lines.join("");
}

export function timestampToChunkIndex(timestamp: string, chunkDurationSeconds: number, startedAt: string): number {
  const start = new Date(startedAt);
  const startSec = start.getHours() * 3600 + start.getMinutes() * 60 + start.getSeconds();
  const [h, m, s] = timestamp.split(":").map(Number);
  const entrySec = h * 3600 + m * 60 + s;
  const diff = entrySec - startSec;
  if (diff < 0) {
    const crossesMidnight = startSec >= 20 * 3600 && entrySec <= 6 * 3600;
    if (!crossesMidnight) return 1;
    const offsetSec = entrySec + 24 * 3600 - startSec;
    return Math.round(offsetSec / chunkDurationSeconds) + 1;
  }
  return Math.round(diff / chunkDurationSeconds) + 1;
}

export function parseTranscriptEntries(content: string, session?: { chunkDurationSeconds: number; startedAt: string }): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // Labels: "Me"/"Others" plus anything live speaker identification wrote
  // ("Speaker N" or a registry name like "Anna") — dropping unknown labels
  // would erase those entries on crash-recovery rewrites.
  const lineRegex = /^\*\*\[(\d{2}:\d{2}:\d{2})\] (.+?):\*\*\s*(.+)$/;
  for (const line of content.split("\n")) {
    const m = lineRegex.exec(line.trim());
    if (!m) continue;
    const [, timestamp, label, text] = m;
    const source = label === "Me" ? "mic" as const : "sys" as const;
    const chunkIndex = session ? timestampToChunkIndex(timestamp, session.chunkDurationSeconds, session.startedAt) : 0;
    const speaker = label !== "Me" && label !== "Others" ? label : undefined;
    entries.push({ source, chunkIndex, timestamp, text: text.trim(), ...(speaker ? { speaker } : {}) });
  }
  return entries;
}

export function transcriptEntriesToMap(entries: TranscriptEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const key = `${e.source}-${String(e.chunkIndex).padStart(3, "0")}`;
    if (e.text) map.set(key, e.text);
  }
  return map;
}

export async function rewriteMarkdown(filePath: string, title: string, startedAt: string, entries: TranscriptEntry[], talkTime?: TalkTimeStats): Promise<void> {
  const markdown = assembleMarkdown(title, startedAt, entries, talkTime);
  await writeFile(filePath, markdown, "utf-8");
}
