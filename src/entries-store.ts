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
  try {
    const content = await readFile(path, "utf-8");
    if (!content.trim()) return [];
    return content
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (err) {
    // File doesn't exist yet
    return [];
  }
}
