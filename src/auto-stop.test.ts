import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calendarCapConfig, decideAutoStop } from "./auto-stop.js";
import { DEFAULT_CONFIG } from "./types.js";

const cfg = {
  calendarCapAutoExtend: true,
  calendarCapAutoExtendStepMinutes: 5,
  calendarCapAutoExtendActivityWindowMinutes: 3,
  calendarCapAutoExtendMaxLagChunks: 2,
  calendarCapWarningLeadMinutes: 5,
};
const opts = { maxDurationMinutes: 38, noTextTimeoutMinutes: 10, calendarHardCapMinutes: 60 };
const state = { elapsedSec: 38 * 60, noTextGapSec: 60, queueLagChunks: 0,
  autoExtendCount: 0, manualCapOverride: false, hardCapWarningSent: false };

describe("calendar cap auto-stop", () => {
  it("extends from elapsed time and waits until the new boundary", () => {
    assert.deepEqual(decideAutoStop(state, opts, cfg), { kind: "continue", extension: { newMaxDurationMinutes: 43, cause: "activity" } });
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 39 * 60, autoExtendCount: 1 }, { ...opts, maxDurationMinutes: 43 }, cfg), { kind: "continue" });
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 47 * 60 + 20 }, opts, cfg), { kind: "continue", extension: { newMaxDurationMinutes: 52 + 1 / 3, cause: "activity" } });
  });

  it("stops at the soft cap when speech is stale, except while the queue is lagging", () => {
    assert.deepEqual(decideAutoStop({ ...state, noTextGapSec: 180 }, opts, cfg), { kind: "stop", reason: "max_duration" });
    assert.deepEqual(decideAutoStop({ ...state, noTextGapSec: 180, queueLagChunks: 2 }, opts, cfg), { kind: "stop", reason: "max_duration" });
    assert.deepEqual(decideAutoStop({ ...state, noTextGapSec: 180, queueLagChunks: 3 }, opts, cfg), { kind: "continue", extension: { newMaxDurationMinutes: 43, cause: "queue_lag" } });
    assert.deepEqual(decideAutoStop({ ...state, noTextGapSec: 60, queueLagChunks: 3 }, opts, cfg), { kind: "continue", extension: { newMaxDurationMinutes: 43, cause: "queue_lag" } });
  });

  it("gives hard cap and ordinary soft stop their precedence", () => {
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 3600, noTextGapSec: 700 }, opts, cfg), { kind: "stop", reason: "calendar_hard_cap" });
    assert.deepEqual(decideAutoStop({ ...state, noTextGapSec: 700 }, opts, cfg), { kind: "stop", reason: "max_duration" });
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 30 * 60, noTextGapSec: 700 }, opts, cfg), { kind: "stop", reason: "no_text_timeout" });
    assert.deepEqual(decideAutoStop({ ...state, noTextGapSec: 700, queueLagChunks: 3 }, opts, cfg), { kind: "stop", reason: "no_text_timeout" });
  });

  it("warns once, after extension, and never on a stop", () => {
    const shortOpts = { ...opts, maxDurationMinutes: 18, calendarHardCapMinutes: 20 };
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 15 * 60 }, shortOpts, cfg), { kind: "continue" });
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 18 * 60 }, shortOpts, cfg), {
      kind: "continue", extension: { newMaxDurationMinutes: 20, cause: "activity" }, warning: { minutesLeft: 2 },
    });
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 18 * 60, hardCapWarningSent: true }, shortOpts, cfg), {
      kind: "continue", extension: { newMaxDurationMinutes: 20, cause: "activity" },
    });
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 20 * 60 }, shortOpts, cfg), { kind: "stop", reason: "calendar_hard_cap" });
  });

  it("manual override and kill switch use ordinary cap semantics", () => {
    assert.deepEqual(decideAutoStop({ ...state, manualCapOverride: true }, opts, cfg), { kind: "stop", reason: "max_duration" });
    assert.deepEqual(decideAutoStop(state, opts, { ...cfg, calendarCapAutoExtend: false }), { kind: "stop", reason: "max_duration" });
    assert.deepEqual(decideAutoStop(state, { ...opts, calendarHardCapMinutes: undefined }, cfg), { kind: "stop", reason: "max_duration" });
    assert.equal(DEFAULT_CONFIG.calendarCapAutoExtend, true);
  });

  it("normalizes unsafe programmatic settings before deciding", () => {
    const normalized = calendarCapConfig({ ...DEFAULT_CONFIG, calendarCapAutoExtendStepMinutes: 0,
      calendarCapAutoExtendActivityWindowMinutes: -1, calendarCapAutoExtendMaxLagChunks: 1.5,
      calendarCapWarningLeadMinutes: Infinity });
    assert.deepEqual(normalized, cfg);
  });

  it("keeps no-text timeout independent of lag and allows disabling it", () => {
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 20 * 60, noTextGapSec: 600, queueLagChunks: 3 }, opts, cfg), { kind: "stop", reason: "no_text_timeout" });
    assert.deepEqual(decideAutoStop({ ...state, elapsedSec: 20 * 60, noTextGapSec: 600, queueLagChunks: 3 }, { ...opts, noTextTimeoutMinutes: 0 }, cfg), { kind: "continue" });
  });
});
