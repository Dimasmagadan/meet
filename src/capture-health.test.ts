import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaptureHealthMonitor, type HealthWarning } from "./capture-health.js";

const config = {
  micRmsThresholdDb: -60,
  sysRmsThresholdDb: -65,
  mode: "full" as const,
  chunkDurationSeconds: 15,
  silentConsecutiveThreshold: 3,
  micMissingChunkThreshold: 2,
};

function loudMetrics(source: "mic" | "sys") {
  return source === "mic"
    ? { rmsDb: -30, peakDb: -10, sampleCount: 240000 }
    : { rmsDb: -25, peakDb: -5, sampleCount: 240000 };
}

const silentMetrics = { rmsDb: -Infinity, peakDb: -Infinity, sampleCount: 240000 };

describe("CaptureHealthMonitor", () => {
  describe("system audio silence detection", () => {
    it("does not warn before threshold consecutive silent chunks", () => {
      const mon = new CaptureHealthMonitor(config);
      const w1 = mon.recordChunk("sys", 1, silentMetrics);
      const w2 = mon.recordChunk("sys", 2, silentMetrics);
      assert.strictEqual(w1, null);
      assert.strictEqual(w2, null);
    });

    it("warns at threshold consecutive silent chunks", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("sys", 1, silentMetrics);
      mon.recordChunk("sys", 2, silentMetrics);
      const w = mon.recordChunk("sys", 3, silentMetrics);
      assert.ok(w);
      assert.strictEqual(w!.type, "sys_silent");
      assert.ok(w!.message.includes("silent for 3"));
    });

    it("resets counter on non-silent chunk", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("sys", 1, silentMetrics);
      mon.recordChunk("sys", 2, silentMetrics);
      mon.recordChunk("sys", 3, loudMetrics("sys"));
      const w = mon.recordChunk("sys", 4, silentMetrics);
      assert.strictEqual(w, null);
    });

    it("does not spam repeated warnings", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("sys", 1, silentMetrics);
      mon.recordChunk("sys", 2, silentMetrics);
      const w3 = mon.recordChunk("sys", 3, silentMetrics);
      assert.ok(w3);
      const w4 = mon.recordChunk("sys", 4, silentMetrics);
      assert.strictEqual(w4, null);
    });

    it("warns again after enough non-warning chunks pass", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("sys", 1, silentMetrics);
      mon.recordChunk("sys", 2, silentMetrics);
      const w3 = mon.recordChunk("sys", 3, silentMetrics);
      assert.ok(w3);
      let repeatedWarning: HealthWarning | null = null;
      for (let i = 4; i <= 12; i++) {
        repeatedWarning = mon.recordChunk("sys", i, silentMetrics) ?? repeatedWarning;
      }
      repeatedWarning = mon.recordChunk("sys", 13, silentMetrics) ?? repeatedWarning;
      assert.ok(repeatedWarning);
      assert.strictEqual(repeatedWarning!.type, "sys_silent");
    });
  });

  describe("mic silence detection", () => {
    it("warns at threshold consecutive silent mic chunks", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("mic", 1, silentMetrics);
      mon.recordChunk("mic", 2, silentMetrics);
      const w = mon.recordChunk("mic", 3, silentMetrics);
      assert.ok(w);
      assert.strictEqual(w!.type, "mic_silent");
    });

    it("does not warn twice for mic silence", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("mic", 1, silentMetrics);
      mon.recordChunk("mic", 2, silentMetrics);
      mon.recordChunk("mic", 3, silentMetrics);
      const w4 = mon.recordChunk("mic", 4, silentMetrics);
      assert.strictEqual(w4, null);
    });
  });

  describe("mic missing detection", () => {
    it("warns when mic produces no chunks while sys does", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("sys", 1, loudMetrics("sys"));
      mon.recordChunk("sys", 2, loudMetrics("sys"));
      const w = mon.checkMicMissing();
      assert.ok(w);
      assert.strictEqual(w!.type, "mic_missing");
    });

    it("does not warn when mic has chunks", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("mic", 1, loudMetrics("mic"));
      mon.recordChunk("sys", 1, loudMetrics("sys"));
      mon.recordChunk("sys", 2, loudMetrics("sys"));
      const w = mon.checkMicMissing();
      assert.strictEqual(w, null);
    });

    it("does not warn before threshold sys chunks", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("sys", 1, loudMetrics("sys"));
      const w = mon.checkMicMissing();
      assert.strictEqual(w, null);
    });

    it("does not warn twice for mic missing", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("sys", 1, loudMetrics("sys"));
      mon.recordChunk("sys", 2, loudMetrics("sys"));
      const w1 = mon.checkMicMissing();
      assert.ok(w1);
      mon.recordChunk("sys", 3, loudMetrics("sys"));
      const w2 = mon.checkMicMissing();
      assert.strictEqual(w2, null);
    });
  });

  describe("stats", () => {
    it("tracks chunk counts and indices", () => {
      const mon = new CaptureHealthMonitor(config);
      mon.recordChunk("mic", 1, loudMetrics("mic"));
      mon.recordChunk("sys", 1, loudMetrics("sys"));
      mon.recordChunk("mic", 2, loudMetrics("mic"));
      mon.recordChunk("sys", 2, loudMetrics("sys"));
      const stats = mon.getStats();
      assert.strictEqual(stats.micChunkCount, 2);
      assert.strictEqual(stats.sysChunkCount, 2);
      assert.strictEqual(stats.lastMicChunkIndex, 2);
      assert.strictEqual(stats.lastSysChunkIndex, 2);
      assert.strictEqual(stats.consecutiveSilentMic, 0);
      assert.strictEqual(stats.consecutiveSilentSys, 0);
    });
  });

  describe("mic-only mode", () => {
    it("does not warn about mic missing in mic mode with no sys", () => {
      const micConfig = { ...config, mode: "mic" as const };
      const mon = new CaptureHealthMonitor(micConfig);
      mon.recordChunk("mic", 1, loudMetrics("mic"));
      const w = mon.checkMicMissing();
      assert.strictEqual(w, null);
    });
  });
});
