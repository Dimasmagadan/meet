import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
