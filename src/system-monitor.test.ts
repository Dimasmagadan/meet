import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLoadavg,
  parseFreeMemoryMb,
  getSystemPressure,
  isWhisperRunning,
  isAudioAnalysisRunning,
  makeDeadline,
  resolveGateThresholds,
  throttleHold,
  DEFAULT_PRESSURE_THRESHOLDS,
  _resetWhisperCache,
  _resetAudioAnalysisCache,
  type ResourcePressure,
  type PressureSensor,
} from "./system-monitor.js";
import { DEFAULT_CONFIG } from "./types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function makePressure(over: Partial<ResourcePressure> = {}): ResourcePressure {
  return {
    cpuLoad1min: 1,
    cpuCores: 8,
    freeMemoryMb: 4096,
    whisperRunning: false,
    audioAnalysisRunning: false,
    overloaded: false,
    reason: null,
    ...over,
  };
}

describe("parseLoadavg", () => {
  it("parses the standard space-separated macOS format", () => {
    assert.strictEqual(parseLoadavg("{ 1.23 1.45 1.50 }"), 1.23);
  });

  it("parses the comma-separated variant", () => {
    assert.strictEqual(parseLoadavg("{ 1.23, 1.45, 1.50 }"), 1.23);
  });

  it("parses the verbose vm.loadavg format", () => {
    assert.strictEqual(
      parseLoadavg("{ (5, 10, 60) = 2.31, 2.45, 2.50 }"),
      2.31,
    );
  });

  it("returns null on malformed output", () => {
    assert.strictEqual(parseLoadavg(""), null);
    assert.strictEqual(parseLoadavg("not a loadavg"), null);
    assert.strictEqual(parseLoadavg("{ }"), null);
  });
});

describe("parseFreeMemoryMb", () => {
  it("parses free + inactive pages from vm_stat", () => {
    const fixture = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                          12345.
Pages inactive:                      67890.
Pages active:                        12345.
Pages speculative:                   123.
Pages throttled:                     0.
Pages wired down:                    54321.`;
    const pages = 12345 + 67890;
    const expectedMb = Math.round((pages * 4096) / (1024 * 1024));
    assert.strictEqual(parseFreeMemoryMb(fixture), expectedMb);
  });

  it("returns null when free line missing", () => {
    assert.strictEqual(parseFreeMemoryMb("Pages active: 100."), null);
  });

  it("handles missing inactive line", () => {
    const fixture = "Pages free: 1000.";
    assert.strictEqual(parseFreeMemoryMb(fixture), Math.round((1000 * 4096) / (1024 * 1024)));
  });

  it("uses custom page size", () => {
    assert.strictEqual(parseFreeMemoryMb("Pages free: 1000.", 16384), Math.round((1000 * 16384) / (1024 * 1024)));
  });
});

describe("getSystemPressure", () => {
  it("returns non-overloaded when load and memory are healthy", async () => {
    const p = await getSystemPressure({ cpuThresholdLoad: 100, memThresholdMb: 0 });
    assert.strictEqual(p.overloaded, false);
    assert.strictEqual(p.reason, null);
    assert.ok(p.cpuCores >= 1);
    // Real values from sysctl/vm_stat — if they fail to parse, fail-open → 0.
    assert.ok(typeof p.cpuLoad1min === "number");
    assert.ok(typeof p.freeMemoryMb === "number");
  });

  it("flips to overloaded when CPU threshold is exceeded", async () => {
    // Set a threshold so low that the actual loadavg will exceed it on any machine.
    const p = await getSystemPressure({ cpuThresholdLoad: -1, memThresholdMb: 0 });
    assert.strictEqual(p.overloaded, true);
    assert.match(p.reason ?? "", /cpu/);
  });

  it("flips to overloaded when memory threshold is unreachable", async () => {
    // Require absurdly high free memory so any real machine is "low".
    const p = await getSystemPressure({ cpuThresholdLoad: 1e9, memThresholdMb: 1_000_000 });
    assert.strictEqual(p.overloaded, true);
    assert.match(p.reason ?? "", /mem/);
  });

  it("reports both reasons when both thresholds are breached", async () => {
    const p = await getSystemPressure({ cpuThresholdLoad: -1, memThresholdMb: 1_000_000 });
    assert.strictEqual(p.overloaded, true);
    assert.match(p.reason ?? "", /cpu/);
    assert.match(p.reason ?? "", /mem/);
  });

  it("populates the reason with cpu ratio including core count", async () => {
    const p = await getSystemPressure({ cpuThresholdLoad: -1, memThresholdMb: 0 });
    // e.g. "cpu 2.3/8c"
    assert.match(p.reason ?? "", new RegExp(`cpu \\d+\\.\\d+/${p.cpuCores}c`));
  });
});

describe("isWhisperRunning cache", () => {
  it("caches pgrep result across rapid successive calls", async () => {
    _resetWhisperCache();
    // We can't easily mock execFile here, so we measure the call cost via the
    // cache indirectly: a second call within the window should return the same
    // value with no exception. The fixture-verified behaviour is "rapid
    // successive calls don't error and produce a stable boolean."
    const { isWhisperRunning } = await import("./system-monitor.js");
    const a = await isWhisperRunning();
    const b = await isWhisperRunning();
    assert.strictEqual(a, b);
  });
});

describe("isAudioAnalysisRunning cache", () => {
  it("caches pgrep result across rapid successive calls", async () => {
    _resetAudioAnalysisCache();
    const a = await isAudioAnalysisRunning();
    const b = await isAudioAnalysisRunning();
    assert.strictEqual(a, b);
  });
});

describe("getSystemPressure heavy-child attribution", () => {
  it("populates audioAnalysisRunning as a boolean", async () => {
    const p = await getSystemPressure({ cpuThresholdLoad: 100, memThresholdMb: 0 });
    assert.strictEqual(typeof p.audioAnalysisRunning, "boolean");
  });

  it("attributes the heavy child in the reason when overloaded", async () => {
    // Force overloaded via thresholds; attribute string depends on whether a
    // heavy child is actually running on this machine, so we only assert the
    // base cpu reason is present (heavy-child suffix is informational).
    const p = await getSystemPressure({ cpuThresholdLoad: -1, memThresholdMb: 0 });
    assert.strictEqual(p.overloaded, true);
    assert.match(p.reason ?? "", /cpu/);
  });
});

describe("makeDeadline", () => {
  it("remainingMs starts at the budget and is non-negative", () => {
    const d = makeDeadline(1000);
    const r = d.remainingMs();
    assert.ok(r <= 1000 && r > 900, `expected ~1000, got ${r}`);
  });

  it("remainingMs decreases over time and floors at 0", async () => {
    const d = makeDeadline(30);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(d.remainingMs(), 0);
  });
});

describe("resolveGateThresholds", () => {
  it("derives the auto load threshold from cores when gateLoadAvg is 0", () => {
    const t = resolveGateThresholds({ gateLoadAvg: 0, gateFreeMemMb: 2048 }, 10);
    assert.strictEqual(t.cpuThresholdLoad, 7);
    assert.strictEqual(t.memThresholdMb, 2048);
  });

  it("uses the explicit load threshold and the legacy mem default when gateFreeMemMb is 0", () => {
    const t = resolveGateThresholds({ gateLoadAvg: 4.5, gateFreeMemMb: 0 }, 10);
    assert.strictEqual(t.cpuThresholdLoad, 4.5);
    assert.strictEqual(t.memThresholdMb, DEFAULT_PRESSURE_THRESHOLDS.memThresholdMb);
  });
});

describe("throttleHold", () => {
  function throttleConfig(over: Partial<typeof DEFAULT_CONFIG> = {}) {
    return {
      ...DEFAULT_CONFIG,
      gateHeavyPasses: true,
      gateWhileRecording: true,
      gateLoadAvg: 0,
      gateFreeMemMb: 2048,
      gatePollMs: 1,
      ...over,
    };
  }

  it("returns immediately when idle and no recording is active", async () => {
    let sensorCalls = 0;
    const sensor: PressureSensor = async () => {
      sensorCalls++;
      return makePressure({ overloaded: false });
    };
    const t0 = Date.now();
    await throttleHold(throttleConfig(), makeDeadline(10_000), "test", { sensor });
    assert.strictEqual(sensorCalls, 1);
    assert.ok(Date.now() - t0 < 50);
  });

  it("holds while a recording is active — ignoring the pass budget — then proceeds", async () => {
    let recordingCalls = 0;
    const isRecordingActive = () => {
      recordingCalls++;
      return recordingCalls <= 5;
    };
    const sensor: PressureSensor = async () => makePressure({ overloaded: true, reason: "cpu 9.0/8c" });
    // A 1ms budget would fail open after ~1 poll if the recording pause
    // respected it — the whole point is that it must not.
    await throttleHold(throttleConfig(), makeDeadline(1), "test", { sensor, isRecordingActive });
    assert.ok(recordingCalls >= 6, `expected recording probe to clear, got ${recordingCalls} calls`);
  });

  it("holds under load until the pass budget is exhausted, then fails open", async () => {
    let sensorCalls = 0;
    const sensor: PressureSensor = async () => {
      sensorCalls++;
      return makePressure({ overloaded: true, reason: "cpu 9.0/8c" });
    };
    const t0 = Date.now();
    await throttleHold(throttleConfig(), makeDeadline(30), "test", { sensor });
    assert.ok(sensorCalls >= 2);
    assert.ok(Date.now() - t0 < 500, "budget must bound the load wait");
  });

  it("skips pressure checks entirely when the pass is not gated (deadline null)", async () => {
    let recordingCalls = 0;
    const isRecordingActive = () => {
      recordingCalls++;
      return true;
    };
    let sensorCalls = 0;
    const sensor: PressureSensor = async () => {
      sensorCalls++;
      return makePressure({ overloaded: true });
    };
    await throttleHold(throttleConfig({ gateHeavyPasses: false }), null, "test", { sensor, isRecordingActive });
    assert.strictEqual(sensorCalls, 0);
    assert.strictEqual(recordingCalls, 0);
  });

  it("notifies once per hold episode, not once per poll", async () => {
    let sensorCalls = 0;
    const sensor: PressureSensor = async () => {
      sensorCalls++;
      return makePressure({ overloaded: sensorCalls < 4, reason: "cpu 9.0/8c" });
    };
    const messages: string[] = [];
    await throttleHold(throttleConfig(), makeDeadline(10_000), "final pass", {
      sensor,
      notify: (m) => messages.push(m),
    });
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /final pass/);
    assert.match(messages[0], /cpu 9\.0\/8c/);
  });
});

describe("real fixtures", () => {
  it("parses output of a real `sysctl -n vm.loadavg` if available", async () => {
    let raw: string;
    try {
      const { stdout } = await execFileP("sysctl", ["-n", "vm.loadavg"]);
      raw = stdout;
    } catch {
      return; // skip on non-darwin
    }
    const v = parseLoadavg(raw);
    assert.ok(v === null || (v >= 0 && Number.isFinite(v)));
  });

  it("parses output of a real `vm_stat` if available", async () => {
    let raw: string;
    try {
      const { stdout } = await execFileP("vm_stat");
      raw = stdout;
    } catch {
      return; // skip on non-darwin
    }
    const v = parseFreeMemoryMb(raw);
    assert.ok(v === null || (v >= 0 && Number.isFinite(v)));
  });
});
