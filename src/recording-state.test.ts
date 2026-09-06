import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRecordingSessions } from "./recording-state.js";
import type { Session } from "./types.js";

function session(dir: string, capturePid: number | null, status: Session["status"] = "recording"): Session {
  return {
    id: dir, title: dir, mode: "full", startedAt: new Date().toISOString(), chunkDurationSeconds: 15,
    sessionDir: dir, outputFile: `${dir}/transcript.md`, capturePid, status, processedChunks: [],
    lastError: null, autoStopReason: null, latestProcessedOffsetSeconds: 0, lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
  };
}

describe("classifyRecordingSessions", () => {
  it("keeps a live capture orphaned when another session owns the active lock", () => {
    const states = classifyRecordingSessions(
      [session("/tmp/a", 101), session("/tmp/b", 102)],
      { pid: 999, sessionDir: "/tmp/b", outputFile: "", title: "b", startedAt: "", updatedAt: "" },
      (pid) => pid === 101 || pid === 999,
    );
    assert.equal(states[0].kind, "orphan");
    assert.equal(states[1].kind, "active");
  });

  it("marks a recording with no live controller or capture as stale", () => {
    const [state] = classifyRecordingSessions([session("/tmp/a", 101)], null, () => false);
    assert.equal(state.kind, "stale");
  });

  // Regression for P1 finding #4: togglePause persists status "paused" but
  // keeps the capture process alive — a paused session with a live capture
  // PID must be classified the same as an active "recording" one, not "stale"
  // (which previously let `meet start` miss the orphan entirely).
  it("classifies a paused recording with a live capture PID as orphan, not stale", () => {
    const [state] = classifyRecordingSessions([session("/tmp/a", 101, "paused")], null, (pid) => pid === 101);
    assert.equal(state.kind, "orphan");
  });

  it("classifies a paused recording owning the active lock as active", () => {
    const [state] = classifyRecordingSessions(
      [session("/tmp/a", 101, "paused")],
      { pid: 999, sessionDir: "/tmp/a", outputFile: "", title: "a", startedAt: "", updatedAt: "" },
      () => false,
    );
    assert.equal(state.kind, "active");
  });

  it("still marks a paused session with no live capture as stale (e.g. finalization-paused after capture ended)", () => {
    const [state] = classifyRecordingSessions([session("/tmp/a", 101, "paused")], null, () => false);
    assert.equal(state.kind, "stale");
  });
});
