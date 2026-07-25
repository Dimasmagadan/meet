import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { concatSysChunks, assignSpeakers, parseDiarizeOutput, buildSpeakerLabelMap, type DiarSegment, type ChunkOffset } from "./diarization.js";
import { makeSineWav, makeSilentWav, readPcmSamples } from "./audio-metrics.js";
import type { TranscriptEntry } from "./types.js";

describe("concatSysChunks", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `meet-test-diarize-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("computes offsets for consecutive chunks", async () => {
    writeFileSync(join(testDir, "sys-001.wav"), makeSineWav(440, 16000)); // 1s
    writeFileSync(join(testDir, "sys-002.wav"), makeSineWav(440, 8000)); // 0.5s

    const { wavPath, offsets } = await concatSysChunks(testDir);

    assert.deepStrictEqual(offsets.get(1), { start: 0, end: 1 });
    assert.deepStrictEqual(offsets.get(2), { start: 1, end: 1.5 });

    const data = await readFile(wavPath);
    const samples = readPcmSamples(data);
    assert.strictEqual(samples.length, 16000 + 8000);
  });

  it("skips missing indices without desyncing later offsets", async () => {
    writeFileSync(join(testDir, "sys-001.wav"), makeSineWav(440, 16000)); // 1s
    // sys-002.wav intentionally missing (e.g. silence-gated and never written)
    writeFileSync(join(testDir, "sys-003.wav"), makeSineWav(440, 16000)); // 1s

    const { offsets } = await concatSysChunks(testDir);

    assert.deepStrictEqual(offsets.get(1), { start: 0, end: 1 });
    assert.strictEqual(offsets.has(2), false);
    // chunk 3 immediately follows chunk 1 in concat time, not at its own index * duration
    assert.deepStrictEqual(offsets.get(3), { start: 1, end: 2 });
  });

  it("handles a short last chunk", async () => {
    writeFileSync(join(testDir, "sys-001.wav"), makeSineWav(440, 16000)); // 1s
    writeFileSync(join(testDir, "sys-002.wav"), makeSineWav(440, 4000)); // 0.25s

    const { offsets } = await concatSysChunks(testDir);
    assert.deepStrictEqual(offsets.get(2), { start: 1, end: 1.25 });
  });

  it("ignores non-sys files and zero-data chunks", async () => {
    writeFileSync(join(testDir, "mic-001.wav"), makeSineWav(440, 16000));
    writeFileSync(join(testDir, "sys-001.wav"), makeSilentWav(0));
    writeFileSync(join(testDir, "sys-002.wav"), makeSineWav(440, 8000));

    const { offsets } = await concatSysChunks(testDir);
    assert.strictEqual(offsets.has(1), false);
    assert.deepStrictEqual(offsets.get(2), { start: 0, end: 0.5 });
  });
});

describe("assignSpeakers", () => {
  const baseEntry = (chunkIndex: number): TranscriptEntry => ({
    source: "sys",
    chunkIndex,
    timestamp: "14:30:00",
    text: `chunk ${chunkIndex}`,
  });

  it("returns entries unchanged when there are no segments", () => {
    const entries = [baseEntry(1)];
    const result = assignSpeakers(entries, [], new Map());
    assert.deepStrictEqual(result, entries);
  });

  it("assigns the clean-overlap speaker", () => {
    const entries = [baseEntry(1)];
    const offsets = new Map<number, ChunkOffset>([[1, { start: 0, end: 15 }]]);
    const segments: DiarSegment[] = [{ start: 0, end: 15, speaker: "1" }];
    const result = assignSpeakers(entries, segments, offsets);
    assert.strictEqual(result[0].speaker, "Speaker 1");
  });

  it("picks the majority speaker on a split overlap", () => {
    const entries = [baseEntry(1)];
    const offsets = new Map<number, ChunkOffset>([[1, { start: 0, end: 15 }]]);
    const segments: DiarSegment[] = [
      { start: 0, end: 4, speaker: "1" },
      { start: 4, end: 15, speaker: "2" },
    ];
    const result = assignSpeakers(entries, segments, offsets);
    assert.strictEqual(result[0].speaker, "Speaker 2");
  });

  it("leaves speaker unset when overlap is below the threshold", () => {
    const entries = [baseEntry(1)];
    const offsets = new Map<number, ChunkOffset>([[1, { start: 0, end: 15 }]]);
    // Only 2s of 15s chunk overlaps a segment (~13%), below default 0.3 threshold
    const segments: DiarSegment[] = [{ start: 0, end: 2, speaker: "1" }];
    const result = assignSpeakers(entries, segments, offsets);
    assert.strictEqual(result[0].speaker, undefined);
  });

  it("respects a custom minOverlapRatio", () => {
    const entries = [baseEntry(1)];
    const offsets = new Map<number, ChunkOffset>([[1, { start: 0, end: 15 }]]);
    const segments: DiarSegment[] = [{ start: 0, end: 2, speaker: "1" }];
    const result = assignSpeakers(entries, segments, offsets, 0.1);
    assert.strictEqual(result[0].speaker, "Speaker 1");
  });

  it("renumbers speakers by first appearance in time, not by raw ID order", () => {
    const entries = [baseEntry(1), baseEntry(2)];
    const offsets = new Map<number, ChunkOffset>([
      [1, { start: 0, end: 15 }],
      [2, { start: 15, end: 30 }],
    ]);
    // Raw speaker "2" speaks first, so it should become "Speaker 1"
    const segments: DiarSegment[] = [
      { start: 0, end: 15, speaker: "2" },
      { start: 15, end: 30, speaker: "1" },
    ];
    const result = assignSpeakers(entries, segments, offsets);
    assert.strictEqual(result[0].speaker, "Speaker 1");
    assert.strictEqual(result[1].speaker, "Speaker 2");
  });

  it("passes through mic entries unchanged", () => {
    const entries: TranscriptEntry[] = [{ source: "mic", chunkIndex: 1, timestamp: "14:30:00", text: "hi" }];
    const offsets = new Map<number, ChunkOffset>([[1, { start: 0, end: 15 }]]);
    const segments: DiarSegment[] = [{ start: 0, end: 15, speaker: "1" }];
    const result = assignSpeakers(entries, segments, offsets);
    assert.strictEqual(result[0].speaker, undefined);
  });

  it("passes through sys entries whose chunk is missing from offsets", () => {
    const entries = [baseEntry(5)];
    const offsets = new Map<number, ChunkOffset>([[1, { start: 0, end: 15 }]]);
    const segments: DiarSegment[] = [{ start: 0, end: 15, speaker: "1" }];
    const result = assignSpeakers(entries, segments, offsets);
    assert.strictEqual(result[0].speaker, undefined);
  });
});

// Pins the Swift->Node diarize JSON contract: DiarizeCommand.swift emits a
// `segments` array plus an additive `embeddings` map keyed by raw speaker id.
// The parser must accept both, and stay backward-compatible with payloads that
// lack `embeddings` (older Swift builds). This is the acceptance seam guard for
// S1 — it runs without the Swift binary.
describe("parseDiarizeOutput (Swift->Node contract)", () => {
  it("parses segments + embeddings from a captured payload", () => {
    const payload = JSON.stringify({
      segments: [
        { start: 0, end: 5, speaker: "1" },
        { start: 5, end: 10, speaker: "2" },
      ],
      speakerCount: 2,
      durationMs: 10000,
      embeddings: {
        "1": Array.from({ length: 256 }, (_, i) => i * 0.01),
        "2": Array.from({ length: 256 }, (_, i) => 1 - i * 0.01),
      },
    });
    const result = parseDiarizeOutput(payload);
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].speaker, "1");
    assert.equal(Object.keys(result.embeddings).length, 2);
    assert.equal(result.embeddings["1"].length, 256);
    assert.equal(result.embeddings["2"].length, 256);
  });

  it("is backward-compatible: payload without embeddings yields empty map", () => {
    const payload = JSON.stringify({ segments: [{ start: 0, end: 5, speaker: "1" }] });
    const result = parseDiarizeOutput(payload);
    assert.equal(result.segments.length, 1);
    assert.deepEqual(result.embeddings, {});
  });

  it("is robust to missing segments (empty array, never undefined)", () => {
    const result = parseDiarizeOutput(JSON.stringify({ embeddings: { "1": [0.1] } }));
    assert.deepEqual(result.segments, []);
    assert.equal(result.embeddings["1"].length, 1);
  });
});

// Embeddings arrive keyed by raw diarizer id ("1","2"); the relabel map produced
// from the raw segments is what lets finalize join them to canonical "Speaker N".
describe("buildSpeakerLabelMap", () => {
  it("maps raw ids to Speaker N by first appearance in time", () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 5, speaker: "2" },
      { start: 5, end: 10, speaker: "1" },
    ];
    const map = buildSpeakerLabelMap(segments);
    assert.equal(map.get("2"), "Speaker 1");
    assert.equal(map.get("1"), "Speaker 2");
  });
});
