import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSummary,
  formatSummaryMarkdown,
  MIN_ENTRIES_FOR_SUMMARY,
  DEFAULT_WINDOW_MAX_ENTRIES,
  DEFAULT_TOP_N,
  summaryOutputPath,
  appendPostFinalizeNote,
} from "./summary.js";
import type { Session, TranscriptEntry } from "./types.js";

function makeEntry(
  source: "mic" | "sys",
  chunkIndex: number,
  text: string,
  timestamp?: string,
): TranscriptEntry {
  const ts = timestamp ?? `14:${String(Math.floor((chunkIndex - 1) / 4)).padStart(2, "0")}:${String(((chunkIndex - 1) % 4) * 15).padStart(2, "0")}`;
  return { source, chunkIndex, timestamp: ts, text };
}

function makeSession(opts: Partial<Session> = {}): Session {
  return {
    id: "test",
    title: "Test Meeting",
    mode: "full",
    startedAt: "2026-05-13T14:30:00.000Z",
    chunkDurationSeconds: 15,
    sessionDir: "/tmp/meet-test",
    outputFile: "/tmp/Meetings/test/transcript.md",
    capturePid: null,
    status: "recording",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
    ...opts,
  };
}

function makeEntries(n: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      makeEntry(
        i % 2 === 0 ? "sys" : "mic",
        i,
        `Это запись номер ${i}. Обсуждаем релиз проекта и фичи.`,
      ),
    );
  }
  return out;
}

describe("extractSummary — early returns", () => {
  it("returns empty arrays for empty input", () => {
    const r = extractSummary([]);
    assert.strictEqual(r.keyPoints.length, 0);
    assert.strictEqual(r.candidateActions.length, 0);
    assert.strictEqual(r.participants.length, 0);
  });

  it("returns no key points below MIN_ENTRIES_FOR_SUMMARY", () => {
    const entries = makeEntries(MIN_ENTRIES_FOR_SUMMARY - 1);
    const r = extractSummary(entries);
    assert.strictEqual(r.keyPoints.length, 0);
    assert.strictEqual(r.candidateActions.length, 0);
    // Participants are still derived for metadata.
    assert.ok(r.participants.length > 0);
  });
});

describe("extractSummary — participants", () => {
  it("derives Me/Others from entry.source", () => {
    const entries = makeEntries(10);
    const r = extractSummary(entries);
    assert.ok(r.participants.includes("Me"));
    assert.ok(r.participants.includes("Others"));
  });

  it("preserves speaker label when entry.speaker is set", () => {
    const entries = makeEntries(10);
    entries[3].speaker = "Speaker 2";
    const r = extractSummary(entries);
    assert.ok(r.participants.includes("Speaker 2"));
  });

  it("falls through to Others for source === 'file'", () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 1; i <= 10; i++) {
      entries.push({ source: "file", chunkIndex: i, timestamp: "00:00:00", text: `Entry ${i} here` });
    }
    const r = extractSummary(entries);
    assert.ok(r.participants.includes("Others"));
  });
});

describe("extractSummary — window slicing", () => {
  it("slices the last MAX_WINDOW_ENTRIES on a 500-entry input", () => {
    const entries = makeEntries(500);
    const r = extractSummary(entries, { maxWindowEntries: DEFAULT_WINDOW_MAX_ENTRIES });
    // Window indices should reflect the last 200 entries (chunks 301..500).
    assert.strictEqual(r.windowStartIndex, 301);
    assert.strictEqual(r.windowEndIndex, 500);
  });

  it("does not slice when entries fit the window", () => {
    const entries = makeEntries(50);
    const r = extractSummary(entries, { maxWindowEntries: DEFAULT_WINDOW_MAX_ENTRIES });
    assert.strictEqual(r.windowStartIndex, 1);
    assert.strictEqual(r.windowEndIndex, 50);
  });

  it("honours a custom maxWindowEntries", () => {
    const entries = makeEntries(100);
    const r = extractSummary(entries, { maxWindowEntries: 30 });
    assert.strictEqual(r.windowStartIndex, 71);
    assert.strictEqual(r.windowEndIndex, 100);
  });
});

describe("extractSummary — topN", () => {
  it("respects the topN clamp", () => {
    const entries = makeEntries(50);
    const r = extractSummary(entries, { topN: 3 });
    assert.ok(r.keyPoints.length <= 3);
    assert.ok(r.keyPoints.length > 0);
  });

  it("uses DEFAULT_TOP_N by default", () => {
    const entries = makeEntries(50);
    const r = extractSummary(entries);
    assert.ok(r.keyPoints.length <= DEFAULT_TOP_N);
    assert.ok(r.keyPoints.length > 0);
  });

  it("re-sorts key points chronologically", () => {
    const entries = makeEntries(30);
    const r = extractSummary(entries);
    for (let i = 1; i < r.keyPoints.length; i++) {
      assert.ok(
        r.keyPoints[i - 1].chunkIndex <= r.keyPoints[i].chunkIndex,
        "key points must be chronological",
      );
    }
  });
});

describe("extractSummary — determinism", () => {
  it("produces identical output for identical input", () => {
    const entries = makeEntries(30);
    const a = extractSummary(entries);
    const b = extractSummary(entries);
    // generatedAt will differ; everything else must match.
    a.generatedAt = b.generatedAt;
    assert.deepStrictEqual(a, b);
  });
});

describe("extractSummary — action items", () => {
  it("matches Russian action-item cues", () => {
    const entries: TranscriptEntry[] = [
      makeEntry("mic", 1, "Привет всем."),
      makeEntry("sys", 2, "Нам нужно обсудить релиз."),
      makeEntry("mic", 3, "Надо сделать это до пятницы."),
      makeEntry("sys", 4, "Сделаем ретро завтра."),
      makeEntry("mic", 5, "Дедлайн в среду."),
      makeEntry("sys", 6, "Обсудим в следующий раз."),
      makeEntry("mic", 7, "Хорошо."),
      makeEntry("sys", 8, "Задача — закрыть баги."),
      makeEntry("mic", 9, "Ок."),
      makeEntry("sys", 10, "Вернёмся к этому позже."),
    ];
    const r = extractSummary(entries);
    const texts = r.candidateActions.map((e) => e.text);
    assert.ok(texts.some((t) => t.includes("нужно")));
    assert.ok(texts.some((t) => t.includes("Надо")));
    assert.ok(texts.some((t) => t.includes("Сделаем")));
    assert.ok(texts.some((t) => t.includes("Дедлайн")));
    assert.ok(texts.some((t) => t.includes("Обсудим")));
    assert.ok(texts.some((t) => t.includes("Задача")));
    assert.ok(texts.some((t) => t.includes("Вернёмся")));
  });

  it("matches English cues", () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      entries.push(makeEntry("mic", i, "Random filler line."));
    }
    entries.push(makeEntry("mic", 9, "The deadline is tomorrow."));
    entries.push(makeEntry("mic", 10, "Add it to the todo list."));
    const r = extractSummary(entries);
    assert.ok(r.candidateActions.length >= 2);
  });

  it("matches 'до пятницы' style deadlines", () => {
    const entries = makeEntries(8);
    entries.push(makeEntry("mic", 9, "Сдай до пятницы."));
    const r = extractSummary(entries);
    assert.ok(r.candidateActions.some((e) => /до/.test(e.text)));
  });

  it("does not flag neutral sentences", () => {
    const entries: TranscriptEntry[] = [
      makeEntry("mic", 1, "Сегодня хорошая погода."),
      makeEntry("sys", 2, "Да, солнечно."),
      makeEntry("mic", 3, "Идём гулять?"),
      makeEntry("sys", 4, "Договорились."),
      makeEntry("mic", 5, "Кофе потом?"),
      makeEntry("sys", 6, "Да, отлично."),
      makeEntry("mic", 7, "Встретимся у парка."),
      makeEntry("sys", 8, "До встречи."),
    ];
    const r = extractSummary(entries);
    assert.strictEqual(r.candidateActions.length, 0);
  });
});

describe("extractSummary — sentence splitting", () => {
  it("splits Russian text on . ! ? … —", () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      entries.push(makeEntry("mic", i, `Точка. Восклицание! Вопрос? Многоточие… Тире — конец.`));
    }
    const r = extractSummary(entries);
    // Doesn't throw; produces some key points.
    assert.ok(r.keyPoints.length > 0);
  });

  it("splits English text correctly", () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 1; i <= 8; i++) {
      entries.push(makeEntry("mic", i, "Sentence one. Sentence two! Sentence three? End."));
    }
    const r = extractSummary(entries);
    assert.ok(r.keyPoints.length > 0);
  });
});

describe("extractSummary — attribution preserved", () => {
  it("keyPoints retain timestamps and speaker labels", () => {
    const entries = makeEntries(20);
    entries[5].speaker = "Speaker 2";
    const r = extractSummary(entries);
    for (const e of r.keyPoints) {
      assert.ok(e.timestamp);
      assert.ok(typeof e.chunkIndex === "number");
    }
  });
});

describe("formatSummaryMarkdown", () => {
  const sampleResult = {
    windowStartIndex: 1,
    windowEndIndex: 68,
    keyPoints: [
      { source: "mic" as const, chunkIndex: 5, timestamp: "14:31:00", text: "Квартальные цели." },
      { source: "sys" as const, chunkIndex: 12, timestamp: "14:33:45", text: "Бэкенд готов." },
    ],
    candidateActions: [
      { source: "sys" as const, chunkIndex: 12, timestamp: "14:33:45", text: "Бэкенд готов." },
    ],
    participants: ["Me", "Others"],
    generatedAt: "2026-05-13T14:47:30.000Z",
  };

  it("renders the header with title and (draft) marker", () => {
    const md = formatSummaryMarkdown(sampleResult, "Weekly Standup", "2026-05-13T14:30:00.000Z");
    assert.match(md, /# Weekly Standup — Summary \(draft\)/);
  });

  it("renders Generated and Window meta", () => {
    const md = formatSummaryMarkdown(sampleResult, "Title", "2026-05-13T14:30:00.000Z");
    assert.match(md, /\*\*Generated:\*\*/);
    assert.match(md, /\*\*Window:\*\*/);
  });

  it("renders the Chunks count when provided", () => {
    const md = formatSummaryMarkdown(sampleResult, "Title", "2026-05-13T14:30:00.000Z", { chunkCount: 68 });
    assert.match(md, /\*\*Chunks:\*\* 68/);
  });

  it("renders key points in the same format as transcript.md entries", () => {
    const md = formatSummaryMarkdown(sampleResult, "Title", "2026-05-13T14:30:00.000Z");
    assert.match(md, /\*\*\[14:31:00\] Me:\*\* Квартальные цели\./);
    assert.match(md, /\*\*\[14:33:45\] Others:\*\* Бэкенд готов\./);
  });

  it("renders the constant footer", () => {
    const md = formatSummaryMarkdown(sampleResult, "Title", "2026-05-13T14:30:00.000Z");
    assert.match(md, /Draft produced locally by extractive summarization\./);
    assert.match(md, /meet summary --full/);
  });

  it("renders section headers even on empty result", () => {
    const empty = {
      windowStartIndex: 0,
      windowEndIndex: 0,
      keyPoints: [],
      candidateActions: [],
      participants: [],
      generatedAt: "2026-05-13T14:47:30.000Z",
    };
    const md = formatSummaryMarkdown(empty, "Empty", "2026-05-13T14:30:00.000Z");
    assert.match(md, /## Key points/);
    assert.match(md, /## Candidate action items/);
    assert.match(md, /## Participants/);
    assert.match(md, /not enough transcript yet/);
  });

  it("preserves Speaker N labels when present", () => {
    const withSpeakers = {
      ...sampleResult,
      keyPoints: [
        { source: "sys" as const, chunkIndex: 12, timestamp: "14:33:45", text: "Бэкенд готов.", speaker: "Speaker 2" },
      ],
    };
    const md = formatSummaryMarkdown(withSpeakers, "Title", "2026-05-13T14:30:00.000Z");
    assert.match(md, /\*\*\[14:33:45\] Speaker 2:\*\*/);
  });
});

describe("summaryOutputPath", () => {
  it("places summary.md next to transcript.md", () => {
    const s = makeSession({ outputFile: "/Users/x/Meetings/2026-05-13_14-30-test/transcript.md" });
    assert.strictEqual(
      summaryOutputPath(s),
      "/Users/x/Meetings/2026-05-13_14-30-test/summary.md",
    );
  });

  it("does not mangle paths without transcript.md suffix", () => {
    const s = makeSession({ outputFile: "/Users/x/Meetings/2026-05-13_14-30-test/notes.md" });
    assert.strictEqual(
      summaryOutputPath(s),
      "/Users/x/Meetings/2026-05-13_14-30-test/summary.md",
    );
  });
});

describe("appendPostFinalizeNote", () => {
  it("is a no-op when summary.md does not exist", async () => {
    const tmp = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { mkdtemp } = tmp;
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "meet-summary-test-"));
    try {
      const s = makeSession({ outputFile: join(dir, "transcript.md") });
      // No summary.md exists; should not throw and should not create one.
      await appendPostFinalizeNote(s);
      const { existsSync } = await import("node:fs");
      assert.strictEqual(existsSync(join(dir, "summary.md")), false);
    } finally {
      await tmp.rm(dir, { recursive: true, force: true });
    }
  });

  it("appends the note when summary.md exists", async () => {
    const tmp = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { mkdtemp, writeFile, readFile } = tmp;
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "meet-summary-test-"));
    try {
      const s = makeSession({ outputFile: join(dir, "transcript.md") });
      await writeFile(join(dir, "summary.md"), "# Existing draft\n\ncontent\n", "utf-8");
      await appendPostFinalizeNote(s);
      const after = await readFile(join(dir, "summary.md"), "utf-8");
      assert.match(after, /Note \(post-finalize\):/);
    } finally {
      await tmp.rm(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — does not duplicate the note on re-finalize", async () => {
    const tmp = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { mkdtemp, writeFile, readFile } = tmp;
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "meet-summary-test-"));
    try {
      const s = makeSession({ outputFile: join(dir, "transcript.md") });
      await writeFile(join(dir, "summary.md"), "# Existing draft\n", "utf-8");
      await appendPostFinalizeNote(s);
      await appendPostFinalizeNote(s);
      const after = await readFile(join(dir, "summary.md"), "utf-8");
      const matches = after.match(/Note \(post-finalize\):/g) ?? [];
      assert.strictEqual(matches.length, 1);
    } finally {
      await tmp.rm(dir, { recursive: true, force: true });
    }
  });
});
