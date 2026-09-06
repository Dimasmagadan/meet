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

// Regression for P1 finding #3: close() previously only closed the watcher —
// queued/in-flight work kept processing (and writing session.json/entries.jsonl)
// after the 'n'/'q' handoff had already spawned a detached finalizer against
// the same session dir.
describe("Pipeline.close()", () => {
  it("halts further dequeueing — queued items are left for the finalizer's own Pipeline to pick up", async () => {
    const pipeline = new Pipeline(makeSession()) as any;
    pipeline.queue = [{ source: "mic", index: 1, wav: "mic-001.wav" }];
    await pipeline.close();
    await pipeline.processNext();
    assert.strictEqual(pipeline.queue.length, 1);
  });

  it("awaits an already in-flight item before resolving", async () => {
    const pipeline = new Pipeline(makeSession()) as any;
    pipeline.processing = true;
    let closed = false;
    const closePromise = pipeline.close().then(() => { closed = true; });

    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(closed, false, "close() must not resolve while the current chunk is still processing");

    // Simulate processNext()'s own completion path (session.json write done).
    pipeline.processing = false;
    await pipeline.processNext();

    await closePromise;
    assert.strictEqual(closed, true);
  });

  it("resolves immediately when nothing is in flight", async () => {
    const pipeline = new Pipeline(makeSession()) as any;
    let closed = false;
    await pipeline.close().then(() => { closed = true; });
    assert.strictEqual(closed, true);
  });

  it("drainStopWaiters resolves pending waiters (in-flight tail with an empty queue)", () => {
    // The entry guard in processNext only fires when more work is queued; when
    // the in-flight item is the last one, the completion tail must drain the
    // waiters itself or close() hangs forever on an idle queue.
    const pipeline = new Pipeline(makeSession()) as any;
    let resolved = 0;
    pipeline.stopResolvers.push(() => { resolved++; });
    pipeline.stopResolvers.push(() => { resolved++; });
    pipeline.drainStopWaiters();
    assert.strictEqual(resolved, 2);
    assert.strictEqual(pipeline.stopResolvers.length, 0);
  });

  it("drains close() waiters when the in-flight WAV disappears", async () => {
    const pipeline = new Pipeline(makeSession()) as any;
    pipeline.processing = true;
    pipeline.stopped = true;
    let closed = false;
    const closePromise = pipeline.close().then(() => { closed = true; });

    // Model processNext()'s missing-file completion branch: it must resolve
    // close() just like the normal transcription completion tail.
    pipeline.processing = false;
    pipeline.drainStopWaiters();
    await closePromise;
    assert.strictEqual(closed, true);
  });

  it("close() during a real transcription resolves after the write lands", async () => {
    // Deterministic interleaving with no whisper binary involved: a silent wav
    // returns from transcribeChunk after a few microtask yields (readFile),
    // giving close() — called synchronously right after enqueue — a genuine
    // in-flight window to wait on. Uses a temp session dir for the writes.
    const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { makeSilentWav } = await import("./audio-metrics.js");
    const dir = mkdtempSync(join(tmpdir(), "meet-test-close-tail-"));
    try {
      writeFileSync(join(dir, "mic-001.wav"), makeSilentWav(16000));
      const session = { ...makeSession(), sessionDir: dir };
      const pipeline = new Pipeline(session) as any;
      pipeline.enqueue("mic", 1, "mic-001.wav");
      assert.strictEqual(pipeline.processing, true);
      let closed = false;
      const closePromise = pipeline.close().then(() => { closed = true; });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("close() hung: tail did not drain waiters")), 10000));
      await Promise.race([closePromise, timeout]);
      assert.strictEqual(closed, true);
      assert.ok(session.processedChunks.some((c: any) => c.source === "mic" && c.index === 1 && c.status === "done"));
      assert.ok(existsSync(join(dir, "session.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
