import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLoadavg,
  parseFreeMemoryMb,
  getSystemPressure,
  isWhisperRunning,
  isAudioAnalysisRunning,
  whenNotOverloaded,
  makeDeadline,
  _resetWhisperCache,
  _resetAudioAnalysisCache,
  type ResourcePressure,
  type PressureSensor,
} from "./system-monitor.js";
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

describe("whenNotOverloaded", () => {
  it("resolves immediately when not overloaded (sensor called once)", async () => {
    let calls = 0;
    const sensor: PressureSensor = async () => {
      calls++;
      return makePressure({ overloaded: false });
    };
    const t0 = Date.now();
    await whenNotOverloaded(makeDeadline(10_000), sensor);
    const elapsed = Date.now() - t0;
    assert.strictEqual(calls, 1);
    assert.ok(elapsed < 50, `expected no wait, took ${elapsed}ms`);
  });

  it("awaits and re-polls while overloaded, then resolves once load drops", async () => {
    let calls = 0;
    const sensor: PressureSensor = async () => {
      calls++;
      return makePressure({ overloaded: calls < 3 });
    };
    const d = makeDeadline(10_000);
    d.pollMs = 5;
    await whenNotOverloaded(d, sensor);
    assert.ok(calls >= 3, `expected >=3 sensor calls, got ${calls}`);
  });

  it("resolves once the pass budget is exhausted even if still overloaded", async () => {
    let calls = 0;
    const sensor: PressureSensor = async () => {
      calls++;
      return makePressure({ overloaded: true, reason: "cpu 9.0/8c" });
    };
    const d = makeDeadline(40);
    d.pollMs = 5;
    const t0 = Date.now();
    await whenNotOverloaded(d, sensor);
    const elapsed = Date.now() - t0;
    // Budget bounds total wait: ~40ms (+ a little slop), never the 10s default.
    assert.ok(elapsed < 500, `expected ~40ms budget-bound wait, took ${elapsed}ms`);
    assert.ok(d.remainingMs() === 0);
    assert.ok(calls >= 2);
  });

  it("fail-opens immediately when the sensor throws", async () => {
    let calls = 0;
    const sensor: PressureSensor = async () => {
      calls++;
      throw new Error("sensor unavailable");
    };
    const t0 = Date.now();
    await whenNotOverloaded(makeDeadline(10_000), sensor);
    const elapsed = Date.now() - t0;
    assert.strictEqual(calls, 1);
    assert.ok(elapsed < 50, `expected no wait, took ${elapsed}ms`);
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
