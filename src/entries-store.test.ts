import { test, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  await t.test("preserves an optional live speaker label", async () => {
    const entry: EntryRecord = {
      source: "sys",
      index: 1,
      timestamp: "00:00:00",
      text: "Hello world",
      rmsDb: -45,
      speaker: "Ann",
    };

    await appendEntryRecord(sessionDir, entry);
    const records = await readEntryRecords(sessionDir);
    assert.equal(records[0].speaker, "Ann");

    await rm(sessionDir, { recursive: true, force: true });
  });

  await t.test("skips a torn last line but keeps prior valid records", async () => {
    const path = join(sessionDir, "entries.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ source: "mic", index: i + 1, timestamp: "00:00:00", text: `chunk ${i + 1}`, rmsDb: -40 })
    );
    const torn = '{"source":"mic","index":11,"timestamp":"00:02:45","text":"cut off mid';
    await writeFile(path, lines.join("\n") + "\n" + torn);

    const records = await readEntryRecords(sessionDir);
    assert.equal(records.length, 10);
    assert.deepEqual(records.map((r) => r.index), [1,2,3,4,5,6,7,8,9,10]);

    await rm(sessionDir, { recursive: true, force: true });
  });

  await t.test("skips a garbage middle line but keeps the rest", async () => {
    const path = join(sessionDir, "entries.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const entry1: EntryRecord = { source: "mic", index: 1, timestamp: "00:00:00", text: "First", rmsDb: -40 };
    const entry2: EntryRecord = { source: "sys", index: 2, timestamp: "00:00:15", text: "Second", rmsDb: -50 };
    await writeFile(path, JSON.stringify(entry1) + "\nnot json at all\n" + JSON.stringify(entry2) + "\n");

    const records = await readEntryRecords(sessionDir);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], entry1);
    assert.deepEqual(records[1], entry2);

    await rm(sessionDir, { recursive: true, force: true });
  });

  await t.test("ignores blank lines interspersed between records", async () => {
    const path = join(sessionDir, "entries.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const entry1: EntryRecord = { source: "mic", index: 1, timestamp: "00:00:00", text: "First", rmsDb: -40 };
    const entry2: EntryRecord = { source: "sys", index: 2, timestamp: "00:00:15", text: "Second", rmsDb: -50 };
    await writeFile(path, JSON.stringify(entry1) + "\n\n\n" + JSON.stringify(entry2) + "\n");

    const records = await readEntryRecords(sessionDir);
    assert.equal(records.length, 2);

    await rm(sessionDir, { recursive: true, force: true });
  });
});

// P3 row 7 (SPEC_SAFETY_NET_2026-10-31 §7): a torn append (crash mid-write)
// leaves the file without a trailing newline — appending raw glued the next
// record onto the torn line and both failed to parse.
describe("appendEntryRecord torn-line repair (P3 row 7)", () => {
  it("prepends a newline when the file lacks a trailing one — both records parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-entries-torn-"));
    try {
      const path = join(dir, "entries.jsonl");
      writeFileSync(path, JSON.stringify({ source: "mic", index: 1, timestamp: "14:30:00", text: "torn", rmsDb: -30 }));
      await appendEntryRecord(dir, { source: "sys", index: 2, timestamp: "14:30:15", text: "next", rmsDb: -30 });
      const records = await readEntryRecords(dir);
      assert.strictEqual(records.length, 2, `both records must parse, got ${JSON.stringify(records)}`);
      assert.strictEqual(records[0].index, 1);
      assert.strictEqual(records[1].index, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not insert a blank line when the file already ends with one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-entries-clean-"));
    try {
      await appendEntryRecord(dir, { source: "mic", index: 1, timestamp: "14:30:00", text: "a", rmsDb: -30 });
      await appendEntryRecord(dir, { source: "mic", index: 2, timestamp: "14:30:15", text: "b", rmsDb: -30 });
      const records = await readEntryRecords(dir);
      assert.strictEqual(records.length, 2);
      assert.strictEqual(records[0].text, "a");
      assert.strictEqual(records[1].text, "b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
