import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkToTimestamp, entriesFromSession, makeHeader, assembleMarkdown, parseTranscriptEntries, transcriptEntriesToMap, timestampToChunkIndex } from "./assembler.js";
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

describe("timestampToChunkIndex", () => {
  const startedAt = new Date(2026, 4, 13, 14, 30, 0).toISOString();

  it("returns 1 for timestamp at session start", () => {
    assert.strictEqual(timestampToChunkIndex("14:30:00", 15, startedAt), 1);
  });

  it("returns 2 for one chunk duration after start", () => {
    assert.strictEqual(timestampToChunkIndex("14:30:15", 15, startedAt), 2);
  });

  it("returns 5 for four chunk durations after start", () => {
    assert.strictEqual(timestampToChunkIndex("14:31:00", 15, startedAt), 5);
  });

  it("returns 1 for timestamp equal to session start", () => {
    assert.strictEqual(timestampToChunkIndex("14:30:00", 15, startedAt), 1);
  });

  it("clamps small pre-start skew to chunk 1", () => {
    assert.strictEqual(timestampToChunkIndex("14:29:59", 15, startedAt), 1);
    assert.strictEqual(timestampToChunkIndex("14:29:45", 15, startedAt), 1);
  });

  it("does not treat afternoon pre-start as midnight rollover", () => {
    assert.strictEqual(timestampToChunkIndex("13:59:45", 15, startedAt), 1);
  });

  it("works with 30s chunks", () => {
    assert.strictEqual(timestampToChunkIndex("14:30:30", 30, startedAt), 2);
    assert.strictEqual(timestampToChunkIndex("14:31:00", 30, startedAt), 3);
  });

  it("maps post-midnight timestamp to correct chunk", () => {
    const midnight = new Date(2026, 4, 13, 23, 59, 45).toISOString();
    assert.strictEqual(timestampToChunkIndex("23:59:45", 15, midnight), 1);
    assert.strictEqual(timestampToChunkIndex("00:00:00", 15, midnight), 2);
    assert.strictEqual(timestampToChunkIndex("00:00:15", 15, midnight), 3);
    assert.strictEqual(timestampToChunkIndex("00:01:00", 15, midnight), 6);
  });
});

describe("parseTranscriptEntries with session context", () => {
  const session = { chunkDurationSeconds: 15, startedAt: new Date(2026, 4, 13, 14, 30, 0).toISOString() };

  it("derives chunkIndex from timestamp with session", () => {
    const md = "**[14:30:00] Me:** Первый\n**[14:30:15] Others:** Второй\n**[14:30:30] Me:** Третий\n";
    const entries = parseTranscriptEntries(md, session);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].chunkIndex, 1);
    assert.strictEqual(entries[1].chunkIndex, 2);
    assert.strictEqual(entries[2].chunkIndex, 3);
  });

  it("uses chunkIndex 0 without session", () => {
    const entries = parseTranscriptEntries("**[14:30:00] Me:** Текст\n");
    assert.strictEqual(entries[0].chunkIndex, 0);
  });
});

describe("fallback chain: parse -> map -> entriesFromSession", () => {
  const startedAt = new Date(2026, 4, 13, 14, 30, 0).toISOString();
  const session: Session = {
    id: "test",
    title: "Test",
    mode: "full",
    startedAt,
    chunkDurationSeconds: 15,
    sessionDir: "/tmp/meet-test",
    outputFile: "/tmp/out.md",
    capturePid: null,
    status: "done",
    processedChunks: [
      { source: "mic", index: 1, wav: "mic-001.wav", status: "done" },
      { source: "mic", index: 2, wav: "mic-002.wav", status: "done" },
      { source: "sys", index: 2, wav: "sys-002.wav", status: "done" },
    ],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
  };

  it("restores transcript entries from parsed markdown", () => {
    const md = "**[14:30:00] Me:** Привет\n**[14:30:15] Me:** Как дела\n**[14:30:15] Others:** Хорошо\n";
    const parsed = parseTranscriptEntries(md, { chunkDurationSeconds: session.chunkDurationSeconds, startedAt });
    const map = transcriptEntriesToMap(parsed);

    assert.strictEqual(map.get("mic-001"), "Привет");
    assert.strictEqual(map.get("mic-002"), "Как дела");
    assert.strictEqual(map.get("sys-002"), "Хорошо");

    const entries = entriesFromSession(session, map);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].chunkIndex, 1);
    assert.strictEqual(entries[0].source, "mic");
    assert.strictEqual(entries[0].text, "Привет");
  });

  it("merges fallback with new live results", () => {
    const md = "**[14:30:00] Me:** Привет\n";
    const parsed = parseTranscriptEntries(md, { chunkDurationSeconds: session.chunkDurationSeconds, startedAt });
    const fallbackMap = transcriptEntriesToMap(parsed);
    const liveResults = new Map<string, string>([
      ["mic-002", "Новый текст"],
      ["sys-002", "Новый ответ"],
    ]);
    const merged = new Map([...fallbackMap, ...liveResults]);
    const entries = entriesFromSession(session, merged);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries.find((e) => e.chunkIndex === 1 && e.source === "mic")?.text, "Привет");
    assert.strictEqual(entries.find((e) => e.chunkIndex === 2 && e.source === "mic")?.text, "Новый текст");
  });
});

describe("fallback chain crossing midnight", () => {
  const startedAt = new Date(2026, 4, 13, 23, 59, 45).toISOString();
  const session: Session = {
    id: "test",
    title: "Test",
    mode: "full",
    startedAt,
    chunkDurationSeconds: 15,
    sessionDir: "/tmp/meet-test",
    outputFile: "/tmp/out.md",
    capturePid: null,
    status: "done",
    processedChunks: [
      { source: "mic", index: 1, wav: "mic-001.wav", status: "done" },
      { source: "mic", index: 2, wav: "mic-002.wav", status: "done" },
      { source: "sys", index: 3, wav: "sys-003.wav", status: "done" },
    ],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
  };

  it("restores post-midnight entries from parsed markdown", () => {
    const md = "**[23:59:45] Me:** До полуночи\n**[00:00:00] Me:** После полуночи\n**[00:00:15] Others:** Ответ после полуночи\n";
    const parsed = parseTranscriptEntries(md, { chunkDurationSeconds: session.chunkDurationSeconds, startedAt });
    const map = transcriptEntriesToMap(parsed);

    assert.strictEqual(map.get("mic-001"), "До полуночи");
    assert.strictEqual(map.get("mic-002"), "После полуночи");
    assert.strictEqual(map.get("sys-003"), "Ответ после полуночи");

    const entries = entriesFromSession(session, map);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].chunkIndex, 1);
    assert.strictEqual(entries[0].text, "До полуночи");
    assert.strictEqual(entries[1].chunkIndex, 2);
    assert.strictEqual(entries[1].text, "После полуночи");
    assert.strictEqual(entries[2].chunkIndex, 3);
    assert.strictEqual(entries[2].text, "Ответ после полуночи");
  });
});
