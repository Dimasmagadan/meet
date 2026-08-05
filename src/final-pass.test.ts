import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFinalPass } from "./final-pass.js";
import { makeSilentWav } from "./audio-metrics.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { Session, Config } from "./types.js";
import type { ResourcePressure, PressureSensor } from "./system-monitor.js";

function makePressure(over: Partial<ResourcePressure> = {}): ResourcePressure {
  return {
    cpuLoad1min: 9,
    cpuCores: 8,
    freeMemoryMb: 4096,
    whisperRunning: false,
    audioAnalysisRunning: false,
    overloaded: false,
    reason: null,
    ...over,
  };
}

function makeSession(sessionDir: string): Session {
  return {
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
  };
}

// Acceptance check for P1: an overloaded sensor + tiny per-pass budget must
// still let the pass RETURN (never hang) once the budget expires, and must
// actually invoke the gate. We use a digitally-silent chunk (inaudible → no
// whisper spawn) so this runs in CI with no whisper-cli binary.
test("runFinalPass — batch gate", async (t) => {
  let dir: string;
  const setup = (): { session: Session; config: Config } => {
    dir = mkdtempSync(join(tmpdir(), "meet-finalpass-gate-"));
    // Silent wav → rmsDb -Infinity < micRmsThresholdDb → inaudible, no whisper.
    writeFileSync(join(dir, "mic-001.wav"), makeSilentWav(16000));
    const session = makeSession(dir);
    const config: Config = { ...DEFAULT_CONFIG, gateHeavyPasses: true, gateBudgetMs: 40 };
    return { session, config };
  };
  const teardown = () => rmSync(dir, { recursive: true, force: true });

  await t.test("calls the gate and returns once the pass budget expires (no hang)", async () => {
    const { session, config } = setup();
    try {
      let calls = 0;
      const sensor: PressureSensor = async () => {
        calls++;
        return makePressure({ overloaded: true, reason: "cpu 9.0/8c" });
      };
      const t0 = Date.now();
      const { entries } = await runFinalPass(session, config, undefined, undefined, undefined, sensor);
      const elapsed = Date.now() - t0;

      // Gate was invoked at least once (proves the pass wires it in).
      assert.ok(calls >= 1, `expected gate sensor to be called, got ${calls}`);
      // Budget-bounded: ~40ms (+slop), never hangs.
      assert.ok(elapsed < 2000, `expected budget-bound return, took ${elapsed}ms`);
      // Silent chunk → no text.
      assert.strictEqual(entries.length, 0);
    } finally {
      teardown();
    }
  });

  await t.test("resolves with no wait when the sensor reports not overloaded", async () => {
    const { session, config } = setup();
    try {
      let calls = 0;
      const sensor: PressureSensor = async () => {
        calls++;
        return makePressure({ overloaded: false });
      };
      const t0 = Date.now();
      await runFinalPass(session, config, undefined, undefined, undefined, sensor);
      const elapsed = Date.now() - t0;
      assert.strictEqual(calls, 1);
      assert.ok(elapsed < 100, `expected no wait, took ${elapsed}ms`);
    } finally {
      teardown();
    }
  });

  await t.test("does NOT invoke the gate when gateHeavyPasses is disabled", async () => {
    const { session } = setup();
    const config: Config = { ...DEFAULT_CONFIG, gateHeavyPasses: false };
    try {
      let calls = 0;
      const sensor: PressureSensor = async () => {
        calls++;
        return makePressure({ overloaded: true });
      };
      await runFinalPass(session, config, undefined, undefined, undefined, sensor);
      assert.strictEqual(calls, 0);
    } finally {
      teardown();
    }
  });
});
