import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTalkTime, formatTalkTimeSection } from "./talk-time.js";
import type { EntryRecord } from "./types.js";
import type { DiarSegment } from "./diarization.js";

describe("computeTalkTime", () => {
  it("splits Me/Others by chunk-counting when diarization is unavailable", () => {
    const entryRecords: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "a", rmsDb: -30 },
      { source: "mic", index: 2, timestamp: "00:00:15", text: "b", rmsDb: -30 },
      { source: "sys", index: 1, timestamp: "00:00:00", text: "c", rmsDb: -30 },
      { source: "sys", index: 2, timestamp: "00:00:15", text: "d", rmsDb: -80 }, // below threshold
    ];
    const stats = computeTalkTime({
      entryRecords,
      chunkDurationSeconds: 15,
      micRmsThresholdDb: -60,
      sysRmsThresholdDb: -65,
      diarSegments: [],
    });

    assert.strictEqual(stats.totalSeconds, 45); // 2 mic chunks (30s) + 1 sys chunk (15s)
    const me = stats.speakers.find((s) => s.label === "Me")!;
    const others = stats.speakers.find((s) => s.label === "Others")!;
    assert.strictEqual(me.seconds, 30);
    assert.strictEqual(others.seconds, 15);
    assert.strictEqual(me.percent + others.percent, 100);
  });

  it("uses diarization segment durations for Speaker N rows when available", () => {
    const entryRecords: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "a", rmsDb: -30 },
    ];
    const diarSegments: DiarSegment[] = [
      { start: 0, end: 15, speaker: "Speaker 1" },
      { start: 15, end: 20, speaker: "Speaker 2" },
    ];
    const stats = computeTalkTime({
      entryRecords,
      chunkDurationSeconds: 15,
      micRmsThresholdDb: -60,
      sysRmsThresholdDb: -65,
      diarSegments,
    });

    assert.strictEqual(stats.speakers.find((s) => s.label === "Me")!.seconds, 15);
    assert.strictEqual(stats.speakers.find((s) => s.label === "Speaker 1")!.seconds, 15);
    assert.strictEqual(stats.speakers.find((s) => s.label === "Speaker 2")!.seconds, 5);
    // Speaker rows sorted numerically after Me
    assert.deepStrictEqual(stats.speakers.map((s) => s.label), ["Me", "Speaker 1", "Speaker 2"]);
  });

  it("uses the diarization-derived Me row instead of raw mic chunk-counting when the mic channel was split (runMicDiarizationStep)", () => {
    // Phone-call scenario: 4 mic chunks total, but only 1 chunk's worth of
    // speech was actually the user per mic diarization — raw chunk-counting
    // would wrongly report 60s of "Me" (all 4 chunks).
    const entryRecords: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "a", rmsDb: -30 },
      { source: "mic", index: 2, timestamp: "00:00:15", text: "b", rmsDb: -30 },
      { source: "mic", index: 3, timestamp: "00:00:30", text: "c", rmsDb: -30 },
      { source: "mic", index: 4, timestamp: "00:00:45", text: "d", rmsDb: -30 },
    ];
    const diarSegments: DiarSegment[] = [
      { start: 0, end: 15, speaker: "Me" },
      { start: 15, end: 60, speaker: "Speaker 1" },
    ];
    const stats = computeTalkTime({
      entryRecords,
      chunkDurationSeconds: 15,
      micRmsThresholdDb: -60,
      sysRmsThresholdDb: -65,
      diarSegments,
    });

    assert.strictEqual(stats.speakers.find((s) => s.label === "Me")!.seconds, 15);
    assert.strictEqual(stats.speakers.find((s) => s.label === "Speaker 1")!.seconds, 45);
    // No "Others" row — sys chunk-counting fallback only applies without diarization.
    assert.strictEqual(stats.speakers.find((s) => s.label === "Others"), undefined);
    assert.deepStrictEqual(stats.speakers.map((s) => s.label), ["Me", "Speaker 1"]);
  });

  it("handles the zero-speech edge without dividing by zero", () => {
    const stats = computeTalkTime({
      entryRecords: [],
      chunkDurationSeconds: 15,
      micRmsThresholdDb: -60,
      sysRmsThresholdDb: -65,
      diarSegments: [],
    });
    assert.strictEqual(stats.totalSeconds, 0);
    for (const s of stats.speakers) {
      assert.strictEqual(s.percent, 0);
    }
  });

  it("rounds percentages to whole numbers", () => {
    const entryRecords: EntryRecord[] = [
      { source: "mic", index: 1, timestamp: "00:00:00", text: "a", rmsDb: -30 },
      { source: "mic", index: 2, timestamp: "00:00:15", text: "b", rmsDb: -30 },
    ];
    const diarSegments: DiarSegment[] = [{ start: 0, end: 15, speaker: "Speaker 1" }];
    const stats = computeTalkTime({
      entryRecords,
      chunkDurationSeconds: 15,
      micRmsThresholdDb: -60,
      sysRmsThresholdDb: -65,
      diarSegments,
    });
    for (const s of stats.speakers) {
      assert.strictEqual(Number.isInteger(s.percent), true);
    }
  });
});

describe("formatTalkTimeSection", () => {
  it("renders a Talk Time section with minutes/seconds and percentages", () => {
    const section = formatTalkTimeSection({
      totalSeconds: 1800,
      speakers: [
        { label: "Me", seconds: 750, percent: 42 },
        { label: "Speaker 1", seconds: 855, percent: 48 },
        { label: "Speaker 2", seconds: 180, percent: 10 },
      ],
    });
    assert.ok(section.startsWith("## Talk Time"));
    assert.ok(section.includes("- Me: 12m 30s (42%)"));
    assert.ok(section.includes("- Speaker 1: 14m 15s (48%)"));
    assert.ok(section.includes("- Speaker 2: 3m 00s (10%)"));
  });
});
