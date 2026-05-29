import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkToTimestamp, entriesFromSession, makeHeader, assembleMarkdown, parseTranscriptEntries, transcriptEntriesToMap } from "./assembler.js";
import type { Session, TranscriptEntry } from "./types.js";

describe("chunkToTimestamp", () => {
  it("computes timestamp from chunk index", () => {
    const d = new Date(2026, 4, 13, 14, 30, 0);
    const startedAt = d.toISOString();
    assert.strictEqual(chunkToTimestamp(1, 30, startedAt), "14:30:00");
    assert.strictEqual(chunkToTimestamp(2, 30, startedAt), "14:30:30");
    assert.strictEqual(chunkToTimestamp(3, 30, startedAt), "14:31:00");
  });

  it("handles chunk 1 at offset 0", () => {
    const d = new Date(2026, 4, 13, 14, 30, 0);
    assert.strictEqual(chunkToTimestamp(1, 15, d.toISOString()), "14:30:00");
  });
});

describe("entriesFromSession", () => {
  const baseSession: Session = {
    id: "test",
    title: "Test",
    mode: "full",
    startedAt: "2026-05-13T14:30:00.000Z",
    chunkDurationSeconds: 30,
    sessionDir: "/tmp/meet-test",
    outputFile: "/tmp/out.md",
    capturePid: null,
    status: "done",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
  };

  it("returns empty for no processed chunks", () => {
    const results = new Map<string, string>();
    assert.deepStrictEqual(entriesFromSession(baseSession, results), []);
  });

  it("skips chunks without text", () => {
    const session = {
      ...baseSession,
      processedChunks: [{ source: "mic" as const, index: 1, wav: "mic-001.wav", status: "done" as const }],
    };
    const results = new Map<string, string>();
    assert.deepStrictEqual(entriesFromSession(session, results), []);
  });

  it("sorts by chunk index then mic before sys", () => {
    const session: Session = {
      ...baseSession,
      processedChunks: [
        { source: "sys", index: 2, wav: "sys-002.wav", status: "done" },
        { source: "mic", index: 2, wav: "mic-002.wav", status: "done" },
        { source: "mic", index: 1, wav: "mic-001.wav", status: "done" },
        { source: "sys", index: 1, wav: "sys-001.wav", status: "done" },
      ],
    };
    const results = new Map<string, string>([
      ["mic-001", "Привет"],
      ["sys-001", "Здравствуйте"],
      ["mic-002", "Как дела"],
      ["sys-002", "Хорошо"],
    ]);
    const entries = entriesFromSession(session, results);
    const indices = entries.map((e) => `${e.chunkIndex}-${e.source}`);
    assert.deepStrictEqual(indices, ["1-mic", "1-sys", "2-mic", "2-sys"]);
  });

  it("skips failed chunks", () => {
    const session: Session = {
      ...baseSession,
      processedChunks: [
        { source: "mic", index: 1, wav: "mic-001.wav", status: "done" },
        { source: "mic", index: 2, wav: "mic-002.wav", status: "failed" },
      ],
    };
    const results = new Map<string, string>([
      ["mic-001", "Текст"],
      ["mic-002", "Не дойдёт"],
    ]);
    const entries = entriesFromSession(session, results);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].chunkIndex, 1);
  });
});

describe("makeHeader", () => {
  it("includes title and formatted date", () => {
    const d = new Date(2026, 4, 13, 14, 30, 0);
    const header = makeHeader("Weekly Standup", d.toISOString());
    assert.ok(header.startsWith("# Weekly Standup"));
    assert.ok(header.includes("14:30"));
  });
});

describe("assembleMarkdown", () => {
  it("produces header and entries", () => {
    const entries: TranscriptEntry[] = [
      { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "Привет" },
      { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "Здравствуйте" },
    ];
    const md = assembleMarkdown("Test", "2026-05-13T14:30:00.000Z", entries);
    assert.ok(md.includes("# Test"));
    assert.ok(md.includes("Me:** Привет"));
    assert.ok(md.includes("Others:** Здравствуйте"));
  });

  it("handles empty entries", () => {
    const md = assembleMarkdown("Empty", "2026-05-13T14:30:00.000Z", []);
    assert.ok(md.startsWith("# Empty"));
  });
});

describe("parseTranscriptEntries", () => {
  it("parses Me entries", () => {
    const entries = parseTranscriptEntries("**[14:30:00] Me:** Привет\n");
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].source, "mic");
    assert.strictEqual(entries[0].timestamp, "14:30:00");
    assert.strictEqual(entries[0].text, "Привет");
  });

  it("parses Others entries", () => {
    const entries = parseTranscriptEntries("**[14:30:15] Others:** Здравствуйте\n");
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].source, "sys");
    assert.strictEqual(entries[0].text, "Здравствуйте");
  });

  it("parses multiple entries", () => {
    const md = "**[14:30:00] Me:** Привет\n**[14:30:15] Others:** Ответ\n**[14:30:30] Me:** Ещё текст\n";
    const entries = parseTranscriptEntries(md);
    assert.strictEqual(entries.length, 3);
  });

  it("skips header lines", () => {
    const md = "# Test — 13.05.2026 14:30\n\n**[14:30:00] Me:** Текст\n";
    const entries = parseTranscriptEntries(md);
    assert.strictEqual(entries.length, 1);
  });

  it("skips blank lines", () => {
    const md = "\n\n**[14:30:00] Me:** Текст\n\n";
    const entries = parseTranscriptEntries(md);
    assert.strictEqual(entries.length, 1);
  });

  it("handles empty string", () => {
    assert.deepStrictEqual(parseTranscriptEntries(""), []);
  });

  it("handles text with colons", () => {
    const entries = parseTranscriptEntries("**[14:30:00] Me:** время: 14:30\n");
    assert.strictEqual(entries[0].text, "время: 14:30");
  });
});

describe("transcriptEntriesToMap", () => {
  it("converts entries to key->text map", () => {
    const entries = [
      { source: "mic" as const, chunkIndex: 1, timestamp: "14:30:00", text: "Привет" },
      { source: "sys" as const, chunkIndex: 1, timestamp: "14:30:00", text: "Ответ" },
    ];
    const map = transcriptEntriesToMap(entries);
    assert.strictEqual(map.get("mic-001"), "Привет");
    assert.strictEqual(map.get("sys-001"), "Ответ");
  });

  it("skips entries without text", () => {
    const entries = [
      { source: "mic" as const, chunkIndex: 1, timestamp: "14:30:00", text: "" },
    ];
    const map = transcriptEntriesToMap(entries);
    assert.strictEqual(map.size, 0);
  });
});
