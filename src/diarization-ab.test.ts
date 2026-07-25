import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDiarizationAbReport } from "./diarization-ab.js";
import type { DiarSegment } from "./diarization.js";

function seg(speaker: string, start: number, end: number): DiarSegment {
  return { speaker, start, end };
}

describe("buildDiarizationAbReport", () => {
  it("perfect agreement: identical segments under different label names", () => {
    const primary: DiarSegment[] = [seg("Speaker 1", 0, 5), seg("Speaker 2", 5, 10)];
    const offline: DiarSegment[] = [seg("Speaker 1", 0, 5), seg("Speaker 2", 5, 10)];

    const report = buildDiarizationAbReport(primary, new Map(), offline, new Map());

    assert.strictEqual(report.primarySpeakerCount, 2);
    assert.strictEqual(report.offlineSpeakerCount, 2);
    assert.strictEqual(report.agreementPct, 100);
    assert.strictEqual(report.swaps, 0);
    assert.deepStrictEqual(report.talkTimeDiffSeconds, { "Speaker 1": 0, "Speaker 2": 0 });
  });

  it("maps labels by overlap even when numbering is swapped between pipelines", () => {
    // Primary calls the first speaker "Speaker 1"; offline calls the same
    // physical voice "Speaker 2" (independent numbering per pipeline).
    const primary: DiarSegment[] = [seg("Speaker 1", 0, 5), seg("Speaker 2", 5, 10)];
    const offline: DiarSegment[] = [seg("Speaker 2", 0, 5), seg("Speaker 1", 5, 10)];

    const report = buildDiarizationAbReport(primary, new Map(), offline, new Map());

    assert.deepStrictEqual(report.labelMapping, { "Speaker 1": "Speaker 2", "Speaker 2": "Speaker 1" });
    assert.strictEqual(report.agreementPct, 100);
    assert.strictEqual(report.swaps, 0);
  });

  it("speaker-count mismatch: offline collapses two speakers into one", () => {
    const primary: DiarSegment[] = [seg("Speaker 1", 0, 5), seg("Speaker 2", 5, 10)];
    const offline: DiarSegment[] = [seg("Speaker 1", 0, 10)];

    const report = buildDiarizationAbReport(primary, new Map(), offline, new Map());

    assert.strictEqual(report.primarySpeakerCount, 2);
    assert.strictEqual(report.offlineSpeakerCount, 1);
    // Both primary speakers overlap "Speaker 1"; the higher-overlap one wins the mapping.
    assert.strictEqual(report.labelMapping["Speaker 1"], "Speaker 1");
    assert.strictEqual(report.labelMapping["Speaker 2"], undefined);
  });

  it("counts a local disagreement as a swap", () => {
    // Speaker 1 (10s total) and Speaker 2 (10s total) each have an unambiguous
    // aggregate majority overlap with one offline label, so the mapping is
    // Speaker1->Speaker1 / Speaker2->Speaker2 — but offline mislabels the
    // 5-10s segment (should be Speaker 2) as Speaker 1.
    const primary: DiarSegment[] = [
      seg("Speaker 1", 0, 5),
      seg("Speaker 2", 5, 10),
      seg("Speaker 1", 10, 15),
      seg("Speaker 2", 15, 20),
    ];
    const offline: DiarSegment[] = [
      seg("Speaker 1", 0, 5),
      seg("Speaker 1", 5, 10), // mislabeled — should agree with Speaker 2
      seg("Speaker 1", 10, 15),
      seg("Speaker 2", 15, 20),
    ];

    const report = buildDiarizationAbReport(primary, new Map(), offline, new Map());

    assert.deepStrictEqual(report.labelMapping, { "Speaker 1": "Speaker 1", "Speaker 2": "Speaker 2" });
    assert.strictEqual(report.swaps, 1);
    assert.strictEqual(report.agreementPct, 75);
  });

  it("talkTimeDiffSeconds reflects duration differences per mapped speaker", () => {
    const primary: DiarSegment[] = [seg("Speaker 1", 0, 8)];
    const offline: DiarSegment[] = [seg("Speaker 1", 0, 5)];

    const report = buildDiarizationAbReport(primary, new Map(), offline, new Map());

    assert.strictEqual(report.talkTimeDiffSeconds["Speaker 1"], 3);
  });

  it("embeddingCosine compares only mapped label pairs with both embeddings present", () => {
    const primary: DiarSegment[] = [seg("Speaker 1", 0, 5), seg("Speaker 2", 5, 10)];
    const offline: DiarSegment[] = [seg("Speaker 1", 0, 5), seg("Speaker 2", 5, 10)];

    const primaryEmb = new Map([
      ["Speaker 1", [1, 0, 0]],
      ["Speaker 2", [1, 0, 0]],
    ]);
    const offlineEmb = new Map([["Speaker 1", [1, 0, 0]]]); // Speaker 2 embedding missing

    const report = buildDiarizationAbReport(primary, primaryEmb, offline, offlineEmb);

    assert.strictEqual(report.embeddingCosine["Speaker 1"], 1);
    assert.strictEqual(report.embeddingCosine["Speaker 2"], undefined);
  });

  it("handles empty segment lists without throwing", () => {
    const report = buildDiarizationAbReport([], new Map(), [], new Map());
    assert.strictEqual(report.primarySpeakerCount, 0);
    assert.strictEqual(report.offlineSpeakerCount, 0);
    assert.strictEqual(report.agreementPct, 0);
    assert.strictEqual(report.swaps, 0);
  });

  it("notes field documents that it never touches transcript.md", () => {
    const report = buildDiarizationAbReport([], new Map(), [], new Map());
    assert.match(report.notes, /does not modify|never modifies/i);
  });
});
