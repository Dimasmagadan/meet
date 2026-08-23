import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRecordingSessions } from "./recording-state.js";
import type { Session } from "./types.js";

function session(dir: string, capturePid: number | null): Session {
  return {
    id: dir, title: dir, mode: "full", startedAt: new Date().toISOString(), chunkDurationSeconds: 15,
    sessionDir: dir, outputFile: `${dir}/transcript.md`, capturePid, status: "recording", processedChunks: [],
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
});
