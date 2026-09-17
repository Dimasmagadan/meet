import { test } from "node:test";
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeMicChunk, hasSysCounterpart, runMicEchoAttributionStep } from "./mic-echo.js";
import { cosineSimilarity, type SpeakerRegistry } from "./speaker-registry.js";
import { makeSineWav } from "./audio-metrics.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { Config, Session, TranscriptEntry } from "./types.js";

const DIM = 256;

// Unit basis vectors: cosine(e_n, e_m) is 1 for n === m and 0 otherwise, so
// matches/thresholds/margins are exact and testable without floating-point
// tolerance games.
function oneHot(n: number): number[] {
  return Array.from({ length: DIM }, (_, k) => (k === n % DIM ? 1 : 0));
}

function makeRegistry(selfEmbedding?: number[]): SpeakerRegistry {
  const speakers: SpeakerRegistry["speakers"] = [];
  if (selfEmbedding) {
    speakers.push({
      id: "self-1",
      name: null,
      embedding: selfEmbedding,
      backend: "diarizer-manager",
      isSelf: true,
      createdAt: "2026-09-11T00:00:00.000Z",
      sourceMeetingId: "m1",
      matchCount: 0,
    });
  }
  return { version: 1, speakers };
}

const SPEAKERS = new Map<string, number[]>([
  ["Speaker 1", oneHot(1)],
  ["Speaker 2", oneHot(2)],
]);

test("attributeMicChunk", (t) => {
  t.test("keeps when sys diarization produced no speakers", () => {
    const d = attributeMicChunk(oneHot(1), new Map(), makeRegistry(), 0.75, 0.7);
    assert.equal(d.kind, "keep");
    assert.equal(d.score, null);
  });

  t.test("keeps an invalid embedding", () => {
    const d = attributeMicChunk([], SPEAKERS, makeRegistry(), 0.75, 0.7);
    assert.equal(d.kind, "keep");
  });

  t.test("matches a remote speaker above threshold", () => {
    const d = attributeMicChunk(oneHot(1), SPEAKERS, makeRegistry(), 0.75, 0.7);
    assert.equal(d.kind, "remote");
    assert.equal(d.label, "Speaker 1");
    assert.equal(d.score, 1);
    assert.equal(d.runnerUp, 0);
  });

  t.test("keeps when no speaker clears the threshold", () => {
    const d = attributeMicChunk(oneHot(7), SPEAKERS, makeRegistry(), 0.75, 0.7);
    assert.equal(d.kind, "keep");
    assert.equal(d.score, 0);
  });

  t.test("keeps when the top two speakers are within the ambiguity margin", () => {
    // 50/50 blend of two orthogonal basis vectors: cosine 0.707 to each,
    // above the 0.7 threshold but with a zero margin between them.
    const mixed = Array.from({ length: DIM }, (_, k) => (k === 1 || k === 2 ? 0.5 : 0));
    const d = attributeMicChunk(mixed, SPEAKERS, makeRegistry(), 0.75, 0.7);
    assert.equal(d.kind, "keep");
    assert.ok(Math.abs(d.score! - Math.SQRT1_2) < 1e-9);
    assert.ok(Math.abs(d.runnerUp! - Math.SQRT1_2) < 1e-9);
  });

  t.test("an enrolled self print wins over a speaker match", () => {
    const d = attributeMicChunk(oneHot(1), SPEAKERS, makeRegistry(oneHot(1)), 0.75, 0.7);
    assert.equal(d.kind, "self");
  });
});

test("hasSysCounterpart", (t) => {
  const sys = new Map<number, string>([
    [1, "У нас есть мероприятие онлайн, хап сейчас приходит"],
    [2, "Все остальные мероприятия идут сейчас в Битрикс"],
  ]);

  t.test("same-index duplicate text", () => {
    assert.equal(hasSysCounterpart("У нас есть мероприятие онлайн хап сейчас приходит", 1, sys, 0.75), true);
  });

  t.test("leading sentence covered by the previous sys chunk (drift case)", () => {
    const mic = "У нас есть мероприятие онлайн все остальные мероприятия идут сейчас в Битрикс";
    assert.equal(hasSysCounterpart(mic, 2, sys, 0.75), true);
  });

  t.test("genuinely distinct mic speech has no counterpart", () => {
    assert.equal(hasSysCounterpart("сейчас разделения на онлайн офлайн в коде нет", 1, sys, 0.75), false);
  });
});

test("runMicEchoAttributionStep", async (t) => {
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

  const noop = () => {};
  const baseConfig: Config = { ...DEFAULT_CONFIG, micEchoMatchThreshold: 0.7 };

  // Fake AudioAnalysis: emits a 256-d one-hot embedding keyed by the chunk
  // number, so mic-001 matches Speaker 1's centroid (oneHot(1)), mic-002
  // matches Speaker 2, and mic-003 matches neither.
  const writeFakeAnalysisBin = (dir: string): string => {
    const bin = join(dir, "fake-audioanalysis.js");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      'const i = process.argv.indexOf("--input");',
      "const input = i >= 0 ? process.argv[i + 1] : '';",
      "const m = /mic-(\\d+)/.exec(input);",
      "const n = m ? parseInt(m[1], 10) % " + DIM + " : -1;",
      "const emb = Array.from({ length: " + DIM + " }, (_, k) => (k === n ? 1 : 0));",
      "process.stdout.write(JSON.stringify({ embedding: emb }));",
      "",
    ].join("\n"));
    chmodSync(bin, 0o755);
    return bin;
  };

  const baseEntries: TranscriptEntry[] = [
    { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "привет, как дела" },
    { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "совершенно другой текст на системном канале" },
    { source: "mic", chunkIndex: 2, timestamp: "14:30:15", text: "обсудим квартальные цели" },
    { source: "sys", chunkIndex: 2, timestamp: "14:30:15", text: "обсудим квартальные цели" },
    { source: "mic", chunkIndex: 3, timestamp: "14:30:30", text: "это говорит сам пользователь" },
  ];

  await t.test("skips when disabled", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-echo-"));
    try {
      const config: Config = { ...baseConfig, micEchoAttribution: false, analysisBin: writeFakeAnalysisBin(sessionDir) };
      const session = makeSession(sessionDir);
      const result = await runMicEchoAttributionStep(
        session, config, baseEntries, SPEAKERS, new Map(), null, new Map(), {}, noop, noop,
      );
      assert.deepStrictEqual(result.entries, baseEntries);
      assert.equal(result.micSegments.length, 0);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips when sys diarization found no speakers", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-echo-"));
    try {
      const config: Config = { ...baseConfig, analysisBin: writeFakeAnalysisBin(sessionDir) };
      const session = makeSession(sessionDir);
      const result = await runMicEchoAttributionStep(
        session, config, baseEntries, new Map(), new Map(), null, new Map(), {}, noop, noop,
      );
      assert.deepStrictEqual(result.entries, baseEntries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips when the final pass correlated no mic chunks (headphones)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-echo-"));
    try {
      writeFileSync(join(sessionDir, "mic-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const config: Config = { ...baseConfig, analysisBin: writeFakeAnalysisBin(sessionDir) };
      const session = makeSession(sessionDir);
      const result = await runMicEchoAttributionStep(
        session, config, baseEntries, SPEAKERS, new Map(), new Set<number>(), new Map(), {}, noop, noop,
      );
      assert.deepStrictEqual(result.entries, baseEntries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("skips mic chunks whose WAV is gone (recovery re-finalize)", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-echo-"));
    try {
      const config: Config = { ...baseConfig, analysisBin: writeFakeAnalysisBin(sessionDir) };
      const session = makeSession(sessionDir);
      const result = await runMicEchoAttributionStep(
        session, config, baseEntries, SPEAKERS, new Map(), null, new Map(), {}, noop, noop,
      );
      assert.deepStrictEqual(result.entries, baseEntries);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("relabels the unmatched voice, drops the sys-covered one, keeps self-like audio", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-echo-"));
    try {
      writeFileSync(join(sessionDir, "mic-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      writeFileSync(join(sessionDir, "mic-002.wav"), makeSineWav(440, 16000, 16000, 0.9));
      writeFileSync(join(sessionDir, "mic-003.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const config: Config = { ...baseConfig, analysisBin: writeFakeAnalysisBin(sessionDir) };
      const session = makeSession(sessionDir);
      const speakersRecord: Record<string, unknown> = {
        segments: [{ start: 0, end: 30, speaker: "Speaker 1" }],
        entryAssignments: [{ source: "sys", chunkIndex: 1, speaker: "Speaker 1" }],
      };
      // mic-001 -> Speaker 1 with no sys counterpart -> relabel;
      // mic-002 -> Speaker 2 with the same text on sys -> drop as echo;
      // mic-003 -> matches neither -> stays "Me".
      const storedRms = new Map([
        ["mic-001", -40],
        ["mic-002", -40],
        ["mic-003", -40],
      ]);
      const logs: string[] = [];
      const result = await runMicEchoAttributionStep(
        session, config, baseEntries, SPEAKERS, new Map([["Speaker 1", "Алексей"]]),
        null, storedRms, speakersRecord, noop, (m) => logs.push(m),
      );

      assert.deepEqual(result.entries.map((e) => [e.source, e.chunkIndex, e.speaker ?? null]), [
        ["mic", 1, "Алексей"],
        ["sys", 1, null],
        ["sys", 2, null],
        ["mic", 3, null],
      ]);
      assert.equal(result.relabeled, 1);
      assert.equal(result.dropped, 1);
      assert.ok(logs.some((l) => l.includes("voice-matched a remote speaker")));

      // Mic chunk 1 is attributed+relabeled; chunk 3 stays audible "Me" time.
      // Chunk 2 was dropped as sys-covered echo — its span must NOT appear
      // here, or computeTalkTime counts that speech once on the sys timeline
      // and again on the mic timeline under the same "Speaker N" (B5).
      const segments = result.micSegments;
      assert.deepEqual(
        segments.map((s) => [s.speaker, s.start, s.end]),
        [["Speaker 1", 0, 1], ["Me", 2, 3]],
      );

      // Bookkeeping: entry assignments cover the relabeled mic chunk (keyed
      // by source so the sys assignment survives), segments carry both
      // channels, and the calibration diagnostics are persisted.
      const assignments = speakersRecord.entryAssignments as Array<{ source: string; chunkIndex: number; speaker: string | null }>;
      assert.ok(assignments.some((a) => a.source === "sys" && a.chunkIndex === 1 && a.speaker === "Speaker 1"));
      assert.ok(assignments.some((a) => a.source === "mic" && a.chunkIndex === 1 && a.speaker === "Алексей"));
      const segmentsRecord = speakersRecord.segments as Array<{ speaker: string }>;
      assert.ok(segmentsRecord.some((s) => s.speaker === "Me"));
      // The sys diarization segment survives the merge. "Speaker 2" does not:
      // its only chunk was dropped as sys-covered echo, so it has no
      // transcript text to rename and no talk-time span (B5).
      assert.ok(segmentsRecord.some((s) => s.speaker === "Speaker 1"));
      assert.ok(!segmentsRecord.some((s) => s.speaker === "Speaker 2"));
      const diag = speakersRecord.micEchoAttribution as { threshold: number; decisions: Array<{ chunkIndex: number; kind: string }> };
      assert.equal(diag.threshold, 0.7);
      assert.deepEqual(diag.decisions.map((d) => [d.chunkIndex, d.kind]), [
        [1, "remote"],
        [2, "remote"],
        [3, "keep"],
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("counts final-pass-only chunks (no stored RMS record) as Me talk time", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-echo-"));
    try {
      writeFileSync(join(sessionDir, "mic-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      writeFileSync(join(sessionDir, "mic-002.wav"), makeSineWav(440, 16000, 16000, 0.9));
      writeFileSync(join(sessionDir, "mic-003.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const config: Config = { ...baseConfig, analysisBin: writeFakeAnalysisBin(sessionDir) };
      const session = makeSession(sessionDir);
      // mic-001: final-pass-only chunk — no entries.jsonl RMS record, but its
      // text survived into the transcript → relabeled (no sys counterpart).
      // mic-002: neither record nor text (silence-gated) → no Me segment.
      // mic-003: stored record, matches no speaker → audible "Me" span.
      const entries: TranscriptEntry[] = [
        { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "хвостовая реплика" },
        { source: "sys", chunkIndex: 1, timestamp: "14:30:00", text: "совсем другой текст" },
        { source: "mic", chunkIndex: 3, timestamp: "14:31:00", text: "пользователь говорит сам" },
      ];
      const speakersRecord: Record<string, unknown> = {};
      const result = await runMicEchoAttributionStep(
        session, config, entries, SPEAKERS, new Map(), null, new Map([["mic-003", -40]]), speakersRecord, noop, noop,
      );
      assert.deepEqual(
        result.micSegments.map((s) => [s.speaker, s.start, s.end]),
        [
          ["Speaker 1", 0, 1],
          ["Me", 2, 3],
        ],
      );
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  await t.test("an enrolled self print keeps the user's chunk as Me", async () => {    const sessionDir = mkdtempSync(join(tmpdir(), "meet-test-mic-echo-"));
    try {
      writeFileSync(join(sessionDir, "mic-001.wav"), makeSineWav(440, 16000, 16000, 0.9));
      const config: Config = {
        ...baseConfig,
        analysisBin: writeFakeAnalysisBin(sessionDir),
        speakerRegistryEnabled: true,
        speakerRegistryPath: join(sessionDir, "registry.json"),
      };
      // mic-001 embeds to oneHot(1); the enrolled self print is the same
      // vector — the chunk is the user speaking, even though "Speaker 1"
      // shares the space in this synthetic setup.
      writeFileSync(config.speakerRegistryPath, JSON.stringify({
        version: 1,
        speakers: [{
          id: "self-1",
          name: null,
          embedding: oneHot(1),
          backend: "diarizer-manager",
          isSelf: true,
          createdAt: "2026-09-11T00:00:00.000Z",
          sourceMeetingId: "m1",
          matchCount: 0,
        }],
      }));
      const session = makeSession(sessionDir);
      const entries: TranscriptEntry[] = [
        { source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "это я" },
      ];
      const speakersRecord: Record<string, unknown> = {};
      const result = await runMicEchoAttributionStep(
        session, config, entries, SPEAKERS, new Map(), null, new Map([["mic-001", -40]]), speakersRecord, noop, noop,
      );
      assert.deepStrictEqual(result.entries, entries);
      assert.equal(result.relabeled, 0);
      assert.deepEqual(
        (speakersRecord.micEchoAttribution as { decisions: Array<{ kind: string }> }).decisions,
        [{ chunkIndex: 1, kind: "self", label: null, score: null, runnerUp: null }],
      );
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

test("cosineSimilarity basis sanity", () => {
  assert.equal(cosineSimilarity(oneHot(3), oneHot(3)), 1);
  assert.equal(cosineSimilarity(oneHot(3), oneHot(4)), 0);
});
