import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { appendEntryRecord, readEntryRecords } from "./entries-store.js";
import type { EntryRecord } from "./types.js";

const tmpDir = () => join(tmpdir(), `meet-test-${randomBytes(4).toString("hex")}`);

test("appendEntryRecord and readEntryRecords", async (t) => {
  const sessionDir = tmpDir();

  await t.test("appends and reads single entry", async () => {
    const entry: EntryRecord = {
      source: "mic",
      index: 1,
      timestamp: "00:00:00",
      text: "Hello world",
      rmsDb: -45.3,
    };

    await appendEntryRecord(sessionDir, entry);
    const records = await readEntryRecords(sessionDir);

    assert.equal(records.length, 1);
    assert.deepEqual(records[0], entry);

    await rm(sessionDir, { recursive: true, force: true });
  });

  await t.test("appends multiple entries", async () => {
    const entry1: EntryRecord = {
      source: "mic",
      index: 1,
      timestamp: "00:00:00",
      text: "First",
      rmsDb: -40,
    };

    const entry2: EntryRecord = {
      source: "sys",
      index: 2,
      timestamp: "00:00:15",
      text: "Second",
      rmsDb: -50,
    };

    await appendEntryRecord(sessionDir, entry1);
    await appendEntryRecord(sessionDir, entry2);

    const records = await readEntryRecords(sessionDir);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], entry1);
    assert.deepEqual(records[1], entry2);

    await rm(sessionDir, { recursive: true, force: true });
  });

  await t.test("reads empty list when no entries exist", async () => {
    const records = await readEntryRecords(sessionDir);
    assert.deepEqual(records, []);
  });

  await t.test("handles empty jsonl file", async () => {
    const path = join(sessionDir, "entries.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path, "");
    const records = await readEntryRecords(sessionDir);
    assert.deepEqual(records, []);

    await rm(sessionDir, { recursive: true, force: true });
  });

  await t.test("preserves text with special characters", async () => {
    const entry: EntryRecord = {
      source: "mic",
      index: 1,
      timestamp: "00:00:00",
      text: 'Hello "world", how\'s it going? Привет мир!',
      rmsDb: -45,
    };

    await appendEntryRecord(sessionDir, entry);
    const records = await readEntryRecords(sessionDir);

    assert.equal(records[0].text, entry.text);

    await rm(sessionDir, { recursive: true, force: true });
  });
});
