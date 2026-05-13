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

export async function rewriteMarkdown(filePath: string, title: string, startedAt: string, entries: TranscriptEntry[]): Promise<void> {
  const markdown = assembleMarkdown(title, startedAt, entries);
  await writeFile(filePath, markdown, "utf-8");
}
