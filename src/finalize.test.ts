import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildBaseResults } from "./finalize.js";
import type { EntryRecord, TranscriptEntry } from "./types.js";

test("buildBaseResults", async (t) => {
  await t.test("stored entries.jsonl text is used when nothing else has it", () => {
    const stored: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "hello from storage", rmsDb: -40 },
    ];
    const result = buildBaseResults(stored, [], new Map());
    assert.equal(result.get("mic-001"), "hello from storage");
  });

  await t.test("live results win over stored text for the same chunk", () => {
    const stored: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "stale stored text", rmsDb: -40 },
    ];
    const live = new Map([["mic-001", "fresh live text"]]);
    const result = buildBaseResults(stored, [], live);
    assert.equal(result.get("mic-001"), "fresh live text");
  });

  await t.test("markdown fallback wins over stored text but loses to live results", () => {
    const stored: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "stored", rmsDb: -40 },
      { source: "mic", index: 2, timestamp: "00:00:15", text: "stored2", rmsDb: -40 },
    ];
    const fallback: TranscriptEntry[] = [
      { source: "mic", chunkIndex: 1, timestamp: "00:00:00", text: "from markdown" },
    ];
    const live = new Map([["mic-002", "from live"]]);
    const result = buildBaseResults(stored, fallback, live);
    assert.equal(result.get("mic-001"), "from markdown");
    assert.equal(result.get("mic-002"), "from live");
  });

  await t.test("empty-text stored records are ignored (silent chunks)", () => {
    const stored: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "", rmsDb: -80 },
    ];
    const result = buildBaseResults(stored, [], new Map());
    assert.equal(result.has("mic-001"), false);
  });

  await t.test("chunks that were live-transcribed but absent from this run's drain still surface via stored text", () => {
    // This is the F1 scenario: chunks 1-5 were transcribed by the recorder's own
    // live pipeline (recorded to entries.jsonl), not by this finalizer's drain.
    const stored: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "chunk one", rmsDb: -40 },
      { source: "sys", index: 1, timestamp: "00:00:00", text: "chunk one sys", rmsDb: -40 },
      { source: "mic", index: 2, timestamp: "00:00:15", text: "chunk two", rmsDb: -40 },
    ];
    const result = buildBaseResults(stored, [], new Map());
    assert.equal(result.size, 3);
    assert.equal(result.get("mic-001"), "chunk one");
    assert.equal(result.get("sys-001"), "chunk one sys");
    assert.equal(result.get("mic-002"), "chunk two");
  });
});
