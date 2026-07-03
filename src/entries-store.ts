import { appendFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EntryRecord } from "./types.js";

export async function appendEntryRecord(sessionDir: string, entry: EntryRecord): Promise<void> {
  const path = join(sessionDir, "entries.jsonl");
  const line = JSON.stringify(entry) + "\n";
  await mkdir(sessionDir, { recursive: true });
  await appendFile(path, line);
}

export async function readEntryRecords(sessionDir: string): Promise<EntryRecord[]> {
  const path = join(sessionDir, "entries.jsonl");
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    // File doesn't exist yet
    return [];
  }
  if (!content.trim()) return [];

  const records: EntryRecord[] = [];
  let skipped = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.error(`entries-store: skipped ${skipped} unparseable line(s) in ${path}`);
  }
  return records;
}
