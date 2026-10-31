import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseResults, mergeRecoveryEntries, runDiarizationStep, runMicDiarizationStep, applyLabelOverridesToTalkTime, filterStoredEntriesByAudio, finalizeSession, deriveMicSegmented, createDebouncedProgressWriter } from "./finalize.js";
import { entriesFromSession } from "./assembler.js";
import { computeTalkTime } from "./talk-time.js";
import { writeAtomic } from "./storage.js";
import { appendPostFinalizeNote } from "./summary.js";
import { makeSilentWav, makeSineWav } from "./audio-metrics.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { EntryRecord, TranscriptEntry, Session, Config } from "./types.js";
import type { TalkTimeStats } from "./talk-time.js";

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

test("mergeRecoveryEntries", async (t) => {
  // Regression for P1 finding #2: entriesFromSession only covers chunks listed
  // as done in processedChunks, so a crashed/partial run whose transcript.md
  // holds text for an unrecorded chunk dropped it whenever any JSONL record
  // existed. Markdown-only chunks must be folded back in per chunk.
  await t.test("recovers a markdown-only chunk missing from session entries", () => {
    const sessionEntries: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "stored chunk" },
    ];
    const fallback: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "stored chunk" },
      { source: "sys", chunkIndex: 2, timestamp: "14:30:15", text: "markdown-only chunk" },
    ];
    const baseResults = new Map([["sys-001", "stored chunk"]]);
    const merged = mergeRecoveryEntries(sessionEntries, fallback, baseResults);
    assert.strictEqual(merged.length, 2);
    assert.strictEqual(merged[1].chunkIndex, 2);
    assert.strictEqual(merged[1].text, "markdown-only chunk");
    assert.strictEqual(baseResults.get("sys-002"), "markdown-only chunk");
  });

  await t.test("does not duplicate already-covered chunks", () => {
    const sessionEntries: TranscriptEntry[] = [
      { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "live" },
    ];
    const fallback: TranscriptEntry[] = [
      { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "live" },
    ];
    const merged = mergeRecoveryEntries(sessionEntries, fallback, new Map([["mic-001", "live"]]));
    assert.strictEqual(merged.length, 1);
  });
});

test("filterStoredEntriesByAudio", async (t) => {
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

  // Regression for P1 finding #2: a chunk with no entries.jsonl record (crashed
  // mid-run) must be judged by analyzing its actual WAV, not assumed silent.
  await t.test("analyzes the WAV directly when a chunk has no stored RMS record", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-filter-stored-"));
    try {
      const session = makeSession(sessionDir);
      writeFileSync(join(sessionDir, "sys-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const entries: TranscriptEntry[] = [
        { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "recovered from markdown" },
      ];
      // Empty stored map: entries.jsonl has no record for this chunk at all.
      const result = await filterStoredEntriesByAudio(entries, new Map(), session, DEFAULT_CONFIG);
      assert.deepStrictEqual(result, entries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("still drops a chunk when the WAV itself is silent", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-filter-stored-"));
    try {
      const session = makeSession(sessionDir);
      writeFileSync(join(sessionDir, "sys-001.wav"), makeSilentWav(16000));
      const entries: TranscriptEntry[] = [
        { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "hallucinated text" },
      ];
      const result = await filterStoredEntriesByAudio(entries, new Map(), session, DEFAULT_CONFIG);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("uses the stored RMS record when present, without touching disk", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-filter-stored-"));
    try {
      const session = makeSession(sessionDir);
      // No WAV on disk at all — must not be reached because the stored record covers it.
      const entries: TranscriptEntry[] = [
        { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "hello" },
      ];
      const stored = new Map([["mic-001", -10]]);
      const result = await filterStoredEntriesByAudio(entries, stored, session, DEFAULT_CONFIG);
      assert.deepStrictEqual(result, entries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  // B11: a mic chunk relabeled "Speaker N" by mic-diarization/mic-echo parses
  // back from markdown as sys; without a sys-NNN.wav it was scored -Infinity
  // and its text dropped from the recovered transcript.
  await t.test("repairs a relabeled mic entry whose parsed sys WAV is absent (B11)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-filter-stored-"));
    try {
      const session = { ...makeSession(sessionDir), mode: "mic" as const };
      writeFileSync(join(sessionDir, "mic-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const entries: TranscriptEntry[] = [
        { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "удалённый голос через микрофон", speaker: "Speaker 1" },
      ];
      const result = await filterStoredEntriesByAudio(entries, new Map(), session, DEFAULT_CONFIG);
      assert.deepStrictEqual(result, [
        { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "удалённый голос через микрофон", speaker: "Speaker 1" },
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  // The B11 repair must not fire in full mode: there a sys entry with a missing
  // sys WAV is a real capture failure, and reattributing it to mic would mask
  // it by silently relabeling remote speech as "Me".
  await t.test("does not reattribute a full-mode sys entry whose WAV is missing", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-filter-stored-"));
    try {
      const session = makeSession(sessionDir);
      writeFileSync(join(sessionDir, "mic-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const entries: TranscriptEntry[] = [
        { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "настоящий системный звук", speaker: "Speaker 1" },
      ];
      const result = await filterStoredEntriesByAudio(entries, new Map(), session, DEFAULT_CONFIG);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("reattributes a full-mode Speaker N entry when speakers.json records it as mic", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-filter-stored-"));
    try {
      const session = makeSession(sessionDir);
      writeFileSync(join(sessionDir, "mic-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const entries: TranscriptEntry[] = [
        { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "голос через микрофон", speaker: "Speaker 1" },
      ];
      const recoveredSources = new Map([["1\u0000Speaker 1", "mic" as const]]);
      const result = await filterStoredEntriesByAudio(entries, new Map(), session, DEFAULT_CONFIG, recoveredSources);
      assert.deepStrictEqual(result, [
        { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "голос через микрофон", speaker: "Speaker 1" },
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("leaves a correctly-attributed sys entry alone when its WAV exists", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-filter-stored-"));
    try {
      const session = makeSession(sessionDir);
      writeFileSync(join(sessionDir, "sys-002.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const entries: TranscriptEntry[] = [
        { source: "sys", chunkIndex: 2, timestamp: "14:30:15", text: "настоящий системный звук", speaker: "Speaker 1" },
      ];
      const result = await filterStoredEntriesByAudio(entries, new Map(), session, DEFAULT_CONFIG);
      assert.deepStrictEqual(result, entries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
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

test("runMicDiarizationStep", async (t) => {
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
  ];

  const noop = () => {};
  // Enable both gates that are off by default, so each test below exercises
  // exactly one remaining gate.
  const enabledConfig: Config = { ...DEFAULT_CONFIG, micDiarizationEnabled: true, speakerRegistryEnabled: true };

  await t.test("skips when micDiarizationEnabled is off (the default)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-diarize-"));
    try {
      const session = makeSession(sessionDir);
      const config: Config = { ...DEFAULT_CONFIG, speakerRegistryEnabled: true };
      const result = await runMicDiarizationStep(session, config, entries, 0, {}, noop, noop);
      assert.deepStrictEqual(result.entries, entries);
      assert.deepStrictEqual(result.micDiarSegments, []);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips when speakerRegistryEnabled is off", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-diarize-"));
    try {
      const session = makeSession(sessionDir);
      const config: Config = { ...DEFAULT_CONFIG, micDiarizationEnabled: true };
      const result = await runMicDiarizationStep(session, config, entries, 0, {}, noop, noop);
      assert.deepStrictEqual(result.entries, entries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips when sys diarization already found speakers (sysSegmentCount > 0)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-diarize-"));
    try {
      const session = makeSession(sessionDir);
      const result = await runMicDiarizationStep(session, enabledConfig, entries, 2, {}, noop, noop);
      assert.deepStrictEqual(result.entries, entries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips and fails open when AudioAnalysis binary is missing", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-diarize-"));
    try {
      const session = makeSession(sessionDir);
      const config: Config = { ...enabledConfig, analysisBin: join(sessionDir, "nonexistent-binary") };
      const result = await runMicDiarizationStep(session, config, entries, 0, {}, noop, noop);
      assert.deepStrictEqual(result.entries, entries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips when there are no mic wav files in the session dir", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-diarize-"));
    try {
      const session = makeSession(sessionDir);
      // enabledConfig.analysisBin ("") resolves via resolveAnalysisBin's default
      // lookup, which may or may not exist on this machine — the mic-file-count
      // gate must be reached (and fire) regardless, since no mic-*.wav exists.
      const result = await runMicDiarizationStep(session, enabledConfig, entries, 0, {}, noop, noop);
      assert.deepStrictEqual(result.entries, entries);
      assert.deepStrictEqual(result.labelOverrides, new Map());
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

test("applyLabelOverridesToTalkTime", async (t) => {
  const base: TalkTimeStats = {
    totalSeconds: 120,
    speakers: [
      { label: "Me", seconds: 30, percent: 25 },
      { label: "Speaker 1", seconds: 60, percent: 50 },
      { label: "Speaker 2", seconds: 30, percent: 25 },
    ],
  };

  await t.test("no-op when overrides map is empty (returns same stats)", () => {
    const out = applyLabelOverridesToTalkTime(base, new Map());
    assert.equal(out, base);
  });

  await t.test("rewrites matched labels and leaves the rest untouched", () => {
    // Reproduces the desync fixed in this PR: the body shows "Женя" (entry label
    // overridden by the registry), but computeTalkTime reads canonical "Speaker 1"
    // off the segments. The footer must mirror the body.
    const out = applyLabelOverridesToTalkTime(
      base,
      new Map([["Speaker 1", "Женя"]]),
    );
    assert.deepEqual(
      out.speakers.map((s) => s.label),
      ["Me", "Женя", "Speaker 2"],
    );
    // Numeric columns unchanged.
    assert.equal(out.speakers[1].seconds, 60);
    assert.equal(out.speakers[1].percent, 50);
    assert.equal(out.totalSeconds, 120);
  });

  await t.test("does not mutate the input stats", () => {
    const overrides = new Map([["Speaker 1", "Женя"]]);
    applyLabelOverridesToTalkTime(base, overrides);
    assert.equal(base.speakers[1].label, "Speaker 1");
  });
});

// P2-2 (SPEC_SAFETY_NET_2026-10-31 §4.2): a chunk WAV whose contents cannot
// be read is unrecovered — never evidence of silence. Pre-fix the analyzer
// fabricated -Infinity, the final pass recorded a "successful silence
// verdict", the unrecovered check re-read the same broken analyzer and
// finalize deleted the session directory with the only recovery artifacts.
test("finalize preserves the session when a chunk WAV is unreadable", async () => {
  // finalizeSession resolves ~/.meet via homedir() — point HOME at a temp dir
  // so the config (absent → DEFAULT_CONFIG), the model paths and the locks
  // all live in a sandbox.
  const savedHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "meet-finalize-home-"));
  process.env.HOME = tempHome;
  const dir = mkdtempSync(join(tmpdir(), "meet-finalize-unreadable-"));
  try {
    // A directory where the chunk file should be: readdir lists it, readFile fails.
    mkdirSync(join(dir, "mic-001.wav"));
    const session: Session = {
      id: "test-unreadable",
      title: "Unreadable",
      mode: "full",
      startedAt: "2026-05-13T14:30:00.000Z",
      chunkDurationSeconds: 30,
      sessionDir: dir,
      outputFile: join(dir, "transcript.md"),
      capturePid: null,
      status: "stopped",
      processedChunks: [{ source: "mic", index: 1, wav: "mic-001.wav", status: "failed" }],
      lastError: null,
      autoStopReason: null,
      latestProcessedOffsetSeconds: 0,
      lastMeaningfulTextAtOffsetSeconds: null,
      hasMeaningfulText: true,
      tags: [],
    };
    await writeAtomic(join(dir, "session.json"), JSON.stringify(session, null, 2));

    const result = await finalizeSession(dir, { foreground: true, pauseForActiveRecording: false });

    assert.ok(existsSync(dir), "session dir must be preserved");
    const persisted = JSON.parse(await readFile(join(dir, "session.json"), "utf-8")) as Session;
    assert.strictEqual(persisted.status, "error");
    assert.ok(String(persisted.lastError).includes("mic-001"), `lastError should name the chunk: ${persisted.lastError}`);
    assert.ok(result.warnings.some((w) => w.includes("Preserving")), `expected a preserve warning, got: ${JSON.stringify(result.warnings)}`);
  } finally {
    process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

// P2-4 (SPEC_SAFETY_NET_2026-10-31 §4.4): the all-dropped echo attribution
// case. deriveMicSegmented is the exact formula finalize uses for micSegmented;
// the computeTalkTime twins pin the talk-time consequence.
test("deriveMicSegmented counts attributed-but-all-dropped as segmented", () => {
  assert.equal(deriveMicSegmented(0, 0, 0), false);
  assert.equal(deriveMicSegmented(2, 0, 0), true);
  assert.equal(deriveMicSegmented(0, 2, 0), true);
  // The regression case: micSegments empty (every match dropped) but the step
  // still voice-matched chunks — the mic fallback must not fire.
  assert.equal(deriveMicSegmented(0, 0, 3), true);
});

test("all-dropped attribution does not double-count Me talk time", () => {
  // The review's 600s listen-only reproduction: 20 chunks × 30s on both
  // channels, every mic chunk voice-matched and dropped as sys-covered echo.
  const records: EntryRecord[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ source: "mic" as const, index: i + 1, timestamp: "14:30:00", text: "", rmsDb: -30 })),
    ...Array.from({ length: 20 }, (_, i) => ({ source: "sys" as const, index: i + 1, timestamp: "14:30:00", text: "", rmsDb: -30 })),
  ];
  const sysSegments = [{ start: 0, end: 600, speaker: "Speaker 1" }];

  // Pre-fix shape: micSegmented false (micSegments empty) → chunk-count
  // fallback re-counts the loud mic records → Me 600 + Speaker 1 600 = 1200s.
  const preFix = computeTalkTime({
    entryRecords: records,
    textChunkKeys: new Set(["sys-001"]),
    chunkDurationSeconds: 30,
    micRmsThresholdDb: -60,
    sysRmsThresholdDb: -60,
    diarSegments: sysSegments,
    micSegmented: false,
    droppedEchoKeys: new Set(),
  });
  assert.equal(preFix.totalSeconds, 1200);

  // Post-fix: finalize derives micSegmented=true from attributedKeys despite
  // the empty micSegments → no fabricated "Me" row, total equals sys total.
  const postFix = computeTalkTime({
    entryRecords: records,
    textChunkKeys: new Set(["sys-001"]),
    chunkDurationSeconds: 30,
    micRmsThresholdDb: -60,
    sysRmsThresholdDb: -60,
    diarSegments: sysSegments,
    micSegmented: deriveMicSegmented(0, 0, 20),
    droppedEchoKeys: new Set(),
  });
  assert.equal(postFix.totalSeconds, 600);
  assert.ok(!postFix.speakers.some((s) => s.label === "Me"), `no Me row expected, got: ${JSON.stringify(postFix.speakers)}`);
  assert.deepEqual(postFix.speakers.map((s) => s.label), ["Speaker 1"]);
});

// P3 row 6 (SPEC_SAFETY_NET_2026-10-31 §7): JSONL records whose chunk never
// made it into processedChunks (crash between the entries.jsonl append and
// the session.json write) previously dropped the chunk's text entirely.
test("entriesFromSession surfaces JSONL-only chunks (P3 row 6)", () => {
  const session: Session = {
    id: "test-jsonl-only",
    title: "JSONL-only",
    mode: "full",
    startedAt: "2026-05-13T14:30:00.000Z",
    chunkDurationSeconds: 30,
    sessionDir: "/tmp/unused",
    outputFile: "/tmp/unused/transcript.md",
    capturePid: null,
    status: "stopped",
    processedChunks: [{ source: "mic", index: 1, wav: "mic-001.wav", status: "done" }],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: true,
    tags: [],
  };
  const results = new Map([
    ["mic-001", "processed chunk text"],
    ["sys-002", "jsonl-only chunk text"],
  ]);
  const entries = entriesFromSession(session, results, [{ source: "sys", index: 2 }]);
  assert.deepEqual(entries.map((e) => [e.source, e.chunkIndex, e.text]), [
    ["mic", 1, "processed chunk text"],
    ["sys", 2, "jsonl-only chunk text"],
  ]);
  // Status filtering still applies to processedChunks: a failed chunk with no
  // text stays out.
  const failed: Session = { ...session, processedChunks: [{ source: "mic", index: 1, wav: "mic-001.wav", status: "failed" }] };
  assert.deepEqual(entriesFromSession(failed, results), []);
});

// P3 row 9 (SPEC_SAFETY_NET_2026-10-31 §7): a late debounced writeAtomic must
// not overwrite the terminal session.json — dispose() awaits the in-flight
// write and cancels the pending flush.
test("progress writer dispose keeps the terminal session.json in place (P3 row 9)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "meet-finalize-progress-"));
  try {
    const session: Session = {
      id: "test-progress",
      title: "Progress",
      mode: "full",
      startedAt: "2026-05-13T14:30:00.000Z",
      chunkDurationSeconds: 30,
      sessionDir: dir,
      outputFile: join(dir, "transcript.md"),
      capturePid: null,
      status: "finalizing",
      processedChunks: [],
      lastError: null,
      autoStopReason: null,
      latestProcessedOffsetSeconds: 0,
      lastMeaningfulTextAtOffsetSeconds: null,
      hasMeaningfulText: true,
      tags: [],
    };
    await writeAtomic(join(dir, "session.json"), JSON.stringify(session, null, 2));
    const writer = createDebouncedProgressWriter(session);

    await writer.update({ phase: "final", done: 1, total: 10, message: null, pid: 1, updatedAt: new Date().toISOString() });
    // Second update within the debounce window schedules the timer.
    await writer.update({ phase: "final", done: 2, total: 10, message: null, pid: 1, updatedAt: new Date().toISOString() });
    // Let the scheduled flush fire and its write begin, then dispose while it
    // may still be in flight, and land the terminal record afterwards.
    await new Promise((r) => setTimeout(r, 1100));
    await writer.dispose();

    const terminal = { ...session, status: "done" as const, finalize: { phase: "done" as const, done: 10, total: 10, message: null, pid: 1, updatedAt: new Date().toISOString() } };
    await writeAtomic(join(dir, "session.json"), JSON.stringify(terminal, null, 2));

    // Pre-fix: a pending or in-flight flush could land after the terminal
    // write and clobber it. Give any such late write ample time to show up.
    await new Promise((r) => setTimeout(r, 1500));
    const persisted = JSON.parse(await readFile(join(dir, "session.json"), "utf-8")) as Session;
    assert.strictEqual(persisted.status, "done");
    assert.strictEqual(persisted.finalize?.phase, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// P3 row 10 (SPEC_SAFETY_NET_2026-10-31 §7): a failed speakers.json write used
// to be swallowed by .catch(() => {}) — rename/suggest then broke silently.
// The failure must surface as a warning while finalize continues.
test("finalize warns and continues when speakers.json is unwritable (P3 row 10)", async () => {
  const savedHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "meet-finalize-home-"));
  process.env.HOME = tempHome;
  const dir = mkdtempSync(join(tmpdir(), "meet-finalize-speakers-"));
  const meetingDir = mkdtempSync(join(tmpdir(), "meet-finalize-meeting-"));
  try {
    // Audible, done chunks with stored text so the diarize block runs and the
    // speakers.json write is reached.
    const wav = makeSineWav(440, 48000, 16000, 0.9);
    writeFileSync(join(dir, "mic-001.wav"), wav);
    writeFileSync(join(dir, "sys-001.wav"), wav);
    const records: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "14:30:00", text: "текст с микрофона", rmsDb: -30 },
      { source: "sys", index: 1, timestamp: "14:30:00", text: "текст с системного канала", rmsDb: -30 },
    ];
    await writeAtomic(join(dir, "entries.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const session: Session = {
      id: "test-speakers-write",
      title: "Speakers Write",
      mode: "full",
      startedAt: "2026-05-13T14:30:00.000Z",
      chunkDurationSeconds: 30,
      sessionDir: dir,
      outputFile: join(meetingDir, "transcript.md"),
      capturePid: null,
      status: "stopped",
      processedChunks: [
        { source: "mic", index: 1, wav: "mic-001.wav", status: "done" },
        { source: "sys", index: 1, wav: "sys-001.wav", status: "done" },
      ],
      lastError: null,
      autoStopReason: null,
      latestProcessedOffsetSeconds: 0,
      lastMeaningfulTextAtOffsetSeconds: null,
      hasMeaningfulText: true,
      tags: [],
    };
    await writeAtomic(join(dir, "session.json"), JSON.stringify(session, null, 2));

    // speakers.json as a DIRECTORY: the atomic rename lands (EISDIR/ENOTEMPTY)
    // → warn → finalize continues to the transcript rewrite.
    mkdirSync(join(meetingDir, "speakers.json"));

    const result = await finalizeSession(dir, { foreground: true, pauseForActiveRecording: false });

    assert.ok(
      result.warnings.some((w) => w.includes("speakers.json write failed")),
      `expected a speakers.json warning, got: ${JSON.stringify(result.warnings)}`,
    );
    // Finalize continued past the failed write.
    assert.ok(existsSync(join(meetingDir, "transcript.md")), "transcript must still be written");
    assert.ok(existsSync(dir) === false, "session completes normally (no unrecovered audio) and is cleaned up");
  } finally {
    process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(meetingDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});
