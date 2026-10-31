import { appendFile, open, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EntryRecord } from "./types.js";

export async function appendEntryRecord(sessionDir: string, entry: EntryRecord): Promise<void> {
  const path = join(sessionDir, "entries.jsonl");
  const line = JSON.stringify(entry) + "\n";
  await mkdir(sessionDir, { recursive: true });
  // P3 (SPEC_SAFETY_NET_2026-10-31 §7 row 7): a torn append (crash mid-write)
  // can leave the file without a trailing newline — appending raw glues the
  // next record onto the torn line and both fail to parse. Prefix a newline
  // when the last byte isn't one. The read side already skips per-line parse
  // failures and logs the count.
  let needsNewline = false;
  try {
    const fh = await open(path, "r");
    try {
      const st = await fh.stat();
      if (st.size > 0) {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, st.size - 1);
        needsNewline = buf[0] !== 0x0a;
      }
    } finally {
      await fh.close();
    }
  } catch {
    // File doesn't exist (or unreadable) — plain append creates/uses it.
  }
  await appendFile(path, (needsNewline ? "\n" : "") + line);
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
