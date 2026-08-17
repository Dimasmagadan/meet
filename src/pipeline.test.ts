import { test, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pipeline } from "./pipeline.js";
import type { Session } from "./types.js";

// P1 rescope acceptance check: the LIVE transcription path (pipeline.ts) must
// remain UN-gated. The spec is explicit that gating it would be self-defeating
// — pipeline.processNext already self-throttles (one whisper at a time via
// this.processing), Swift keeps producing 15s chunks regardless of load, and
// blocking processNext under pressure just backs up the unbounded live queue
// (manufacturing the very lag P5 surfaces). Live-path pressure is instead
// handled by self-throttling + QoS (P3) + waitForInactiveRecording.
//
// We can't run real whisper-cli in CI, so this is a source-level seam guard:
// it pins that pipeline.ts does NOT wire in the system-pressure gate. A unit
// test on whenNotOverloaded alone cannot prove the wiring excludes the live
// path — this does.
//
// Runs against the compiled sibling pipeline.js (identifiers/import paths are
// preserved verbatim by tsc), since node --test executes dist/**/*.test.js.
const pipelineSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "pipeline.js"),
  "utf-8",
);

test("pipeline live path is un-gated (P1 rescope seam guard)", () => {
  assert.ok(
    !/whenNotOverloaded/.test(pipelineSrc),
    "pipeline.ts must not reference whenNotOverloaded — the live path is deliberately un-gated",
  );
  assert.ok(
    !/from\s+["']\.\/system-monitor/.test(pipelineSrc),
    "pipeline.ts must not import system-monitor — gating belongs to batch passes only",
  );
  assert.ok(
    !/makeDeadline/.test(pipelineSrc),
    "pipeline.ts must not create a pressure deadline — live path is self-throttling",
  );
});

function makeSession(): Session {
  return {
    id: "test",
    title: "Test",
    mode: "mic",
    startedAt: new Date().toISOString(),
    chunkDurationSeconds: 15,
    sessionDir: "/tmp/does-not-exist",
    outputFile: "/tmp/does-not-exist/transcript.md",
    capturePid: null,
    status: "recording",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
  };
}

// Regression for the stop()-during-transcription race: a chunk that has
// already left `queue` (shifted by processNext) but hasn't yet landed in
// processedChunks (only pushed once transcribeChunk resolves) used to look
// unprocessed to rescan()/enqueue(), so stop()'s rescan re-queued it for a
// second transcription. inFlightKey closes that window.
describe("Pipeline in-flight tracking", () => {
  it("isProcessed() treats the in-flight key as claimed", () => {
    const pipeline = new Pipeline(makeSession()) as any;
    assert.strictEqual(pipeline.isProcessed("mic-001"), false);
    pipeline.inFlightKey = "mic-001";
    assert.strictEqual(pipeline.isProcessed("mic-001"), true);
  });

  it("enqueue() skips re-adding a chunk that's currently in-flight", () => {
    const pipeline = new Pipeline(makeSession()) as any;
    pipeline.inFlightKey = "mic-001";
    pipeline.enqueue("mic", 1, "mic-001.wav");
    assert.strictEqual(pipeline.queue.length, 0);
  });

  it("enqueue() re-allows the chunk once in-flight clears without a done record", () => {
    const pipeline = new Pipeline(makeSession()) as any;
    pipeline.drainMode = true; // isolate enqueue's own logic from processNext auto-trigger
    pipeline.inFlightKey = "mic-001";
    pipeline.inFlightKey = null; // transcription failed, not marked "done"
    pipeline.enqueue("mic", 1, "mic-001.wav");
    assert.strictEqual(pipeline.queue.length, 1);
  });
});
