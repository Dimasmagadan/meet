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
    const text = results.get(key) || "(empty)";
    const timestamp = chunkToTimestamp(chunk.index, session.chunkDurationSeconds, session.startedAt);
    entries.push({ source: chunk.source, chunkIndex: chunk.index, timestamp, text });
  }

  entries.sort((a, b) => {
    if (a.chunkIndex !== b.chunkIndex) return a.chunkIndex - b.chunkIndex;
    return a.source === "mic" ? -1 : 1;
  });

  return entries;
}

export function assembleMarkdown(title: string, startedAt: string, entries: TranscriptEntry[]): string {
  const date = new Date(startedAt);
  const dateStr = date.toLocaleDateString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit" });
  const timeStr = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  const lines: string[] = [
    `# ${title} — ${dateStr} ${timeStr}`,
    "",
  ];

  for (const entry of entries) {
    const label = entry.source === "mic" ? "Me" : "Others";
    lines.push(`**[${entry.timestamp}] ${label}:** ${entry.text}`);
    lines.push("");
  }

  return lines.join("\n");
}
