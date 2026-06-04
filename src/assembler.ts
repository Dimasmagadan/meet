import { appendFile, writeFile } from "node:fs/promises";
import type { TranscriptEntry, Session } from "./types.js";

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
    entries.push({ source: chunk.source, chunkIndex: chunk.index, timestamp, text });
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
  const label = entry.source === "mic" ? "Me" : "Others";
  return `**[${entry.timestamp}] ${label}:** ${entry.text}\n`;
}

export function makeHeader(title: string, startedAt: string): string {
  const date = new Date(startedAt);
  const dateStr = date.toLocaleDateString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit" });
  const timeStr = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `# ${title} — ${dateStr} ${timeStr}\n\n`;
}

export async function appendEntry(filePath: string, header: string, entry: TranscriptEntry): Promise<void> {
  const line = formatEntry(entry);
  await appendFile(filePath, line);
}

export function assembleMarkdown(title: string, startedAt: string, entries: TranscriptEntry[]): string {
  const lines: string[] = [
    `# ${title} — ${new Date(startedAt).toLocaleDateString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit" })} ${new Date(startedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`,
    "",
  ];

  for (const entry of entries) {
    lines.push(formatEntry(entry));
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
  const lineRegex = /^\*\*\[(\d{2}:\d{2}:\d{2})\] (Me|Others):\*\*\s*(.+)$/;
  for (const line of content.split("\n")) {
    const m = lineRegex.exec(line.trim());
    if (!m) continue;
    const [, timestamp, label, text] = m;
    const source = label === "Me" ? "mic" as const : "sys" as const;
    const chunkIndex = session ? timestampToChunkIndex(timestamp, session.chunkDurationSeconds, session.startedAt) : 0;
    entries.push({ source, chunkIndex, timestamp, text: text.trim() });
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

export async function rewriteMarkdown(filePath: string, title: string, startedAt: string, entries: TranscriptEntry[]): Promise<void> {
  const markdown = assembleMarkdown(title, startedAt, entries);
  await writeFile(filePath, markdown, "utf-8");
}
