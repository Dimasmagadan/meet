import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseResults, runDiarizationStep } from "./finalize.js";
import { appendPostFinalizeNote } from "./summary.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { EntryRecord, TranscriptEntry, Session, Config } from "./types.js";

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

test("runDiarizationStep", async (t) => {
  const makeSession = (sessionDir: string): Session => ({
    id: "test-session",
    title: "Test",
    mode: "full",
    startedAt: "2026-05-13T14:30:00.000Z",
    chunkDurationSeconds: 15,
    sessionDir,
    outputFile: join(sessionDir, "transcript.md"),
    capturePid: null,
    status: "finalizing",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
  });

  const entries: TranscriptEntry[] = [
    { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "hello" },
    { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "hi there" },
  ];

  const noop = () => {};

  await t.test("skips and fails open when AudioAnalysis binary is missing", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-diarize-"));
    try {
      const session = makeSession(sessionDir);
      const config: Config = { ...DEFAULT_CONFIG, analysisBin: join(sessionDir, "nonexistent-binary") };
      const warnings: string[] = [];
      const { entries: result, speakersRecord } = await runDiarizationStep(session, config, entries, (m) => warnings.push(m), noop);

      assert.deepStrictEqual(result, entries);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Diarization skipped/);
      assert.equal((speakersRecord.diarization as { ok: boolean }).ok, false);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips silently when diarization is disabled", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-diarize-"));
    try {
      const session = makeSession(sessionDir);
      const config: Config = { ...DEFAULT_CONFIG, diarizationEnabled: false };
      const warnings: string[] = [];
      const { entries: result } = await runDiarizationStep(session, config, entries, (m) => warnings.push(m), noop);

      assert.deepStrictEqual(result, entries);
      assert.equal(warnings.length, 0);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips when there are no sys entries", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-diarize-"));
    try {
      const session = makeSession(sessionDir);
      const config: Config = { ...DEFAULT_CONFIG };
      const micOnly: TranscriptEntry[] = [{ source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "hello" }];
      const { entries: result } = await runDiarizationStep(session, config, micOnly, noop, noop);
      assert.deepStrictEqual(result, micOnly);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips when session mode is mic-only", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-diarize-"));
    try {
      const session = { ...makeSession(sessionDir), mode: "mic" as const };
      const config: Config = { ...DEFAULT_CONFIG };
      const { entries: result } = await runDiarizationStep(session, config, entries, noop, noop);
      assert.deepStrictEqual(result, entries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

test("appendPostFinalizeNote", async (t) => {
  const makeSession = (sessionDir: string): Session => ({
    id: "test-session",
    title: "Test",
    mode: "full",
    startedAt: "2026-05-13T14:30:00.000Z",
    chunkDurationSeconds: 15,
    sessionDir,
    outputFile: join(sessionDir, "transcript.md"),
    capturePid: null,
    status: "done",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
  });

  await t.test("does NOT create summary.md when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-finalize-sum-"));
    try {
      const session = makeSession(dir);
      await appendPostFinalizeNote(session);
      assert.equal(existsSync(join(dir, "summary.md")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("appends the post-finalize note when summary.md exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-finalize-sum-"));
    try {
      const session = makeSession(dir);
      writeFileSync(join(dir, "summary.md"), "# Draft\n\ncontent\n", "utf-8");
      await appendPostFinalizeNote(session);
      const after = readFileSync(join(dir, "summary.md"), "utf-8");
      assert.match(after, /Note \(post-finalize\):/);
      assert.match(after, /Speaker N labels/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test("is idempotent on re-finalize", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-finalize-sum-"));
    try {
      const session = makeSession(dir);
      writeFileSync(join(dir, "summary.md"), "# Draft\n", "utf-8");
      await appendPostFinalizeNote(session);
      await appendPostFinalizeNote(session);
      const after = readFileSync(join(dir, "summary.md"), "utf-8");
      const matches = after.match(/Note \(post-finalize\):/g) ?? [];
      assert.equal(matches.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
