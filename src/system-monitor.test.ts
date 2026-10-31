import { describe, it, beforeEach, afterEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  parseLoadavg,
  parseFreeMemoryMb,
  parseVmStatPageSize,
  getSystemPressure,
  isWhisperRunning,
  isAudioAnalysisRunning,
  makeDeadline,
  resolveGateThresholds,
  throttleHold,
  DEFAULT_PRESSURE_THRESHOLDS,
  _resetWhisperCache,
  _resetAudioAnalysisCache,
  _resetPageSizeCache,
  type ResourcePressure,
  type PressureSensor,
} from "./system-monitor.js";
import { DEFAULT_CONFIG } from "./types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

// The default sensor shells out to darwin-only `sysctl`/`vm_stat` probes
// (CI_LINUX_FINDINGS §7.3.9) — on any other platform load/free-memory read
// null and the threshold tests can never trip. Per-test skip, not a
// suite-level skip option: node 24 drops suite-skipped subtests from the
// summary count entirely, which would make the expected count
// platform-dependent. The parser suites and the PATH-stubbed suite below are
// platform-neutral and stay live everywhere.
function skipIfNotDarwin(t: TestContext): boolean {
  if (process.platform !== "darwin") {
    t.skip("default sensor probes are macOS-only");
    return true;
  }
  return false;
}

describe("getSystemPressure", () => {
  it("returns non-overloaded when load and memory are healthy", async (t) => {
    if (skipIfNotDarwin(t)) return;
    const p = await getSystemPressure({ cpuThresholdLoad: 100, memThresholdMb: 0 });
    assert.strictEqual(p.overloaded, false);
    assert.strictEqual(p.reason, null);
    assert.ok(p.cpuCores >= 1);
    // Real values from sysctl/vm_stat — if they fail to parse, fail-open → 0.
    assert.ok(typeof p.cpuLoad1min === "number");
    assert.ok(typeof p.freeMemoryMb === "number");
  });

  it("flips to overloaded when CPU threshold is exceeded", async (t) => {
    if (skipIfNotDarwin(t)) return;
    // Set a threshold so low that the actual loadavg will exceed it on any machine.
    const p = await getSystemPressure({ cpuThresholdLoad: -1, memThresholdMb: 0 });
    assert.strictEqual(p.overloaded, true);
    assert.match(p.reason ?? "", /cpu/);
  });

  it("flips to overloaded when memory threshold is unreachable", async (t) => {
    if (skipIfNotDarwin(t)) return;
    // Require absurdly high free memory so any real machine is "low".
    const p = await getSystemPressure({ cpuThresholdLoad: 1e9, memThresholdMb: 1_000_000 });
    assert.strictEqual(p.overloaded, true);
    assert.match(p.reason ?? "", /mem/);
  });

  it("reports both reasons when both thresholds are breached", async (t) => {
    if (skipIfNotDarwin(t)) return;
    const p = await getSystemPressure({ cpuThresholdLoad: -1, memThresholdMb: 1_000_000 });
    assert.strictEqual(p.overloaded, true);
    assert.match(p.reason ?? "", /cpu/);
    assert.match(p.reason ?? "", /mem/);
  });

  it("populates the reason with cpu ratio including core count", async (t) => {
    if (skipIfNotDarwin(t)) return;
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
  it("populates audioAnalysisRunning as a boolean", async (t) => {
    if (skipIfNotDarwin(t)) return;
    const p = await getSystemPressure({ cpuThresholdLoad: 100, memThresholdMb: 0 });
    assert.strictEqual(typeof p.audioAnalysisRunning, "boolean");
  });

  it("attributes the heavy child in the reason when overloaded", async (t) => {
    if (skipIfNotDarwin(t)) return;
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
  // Tests that don't exercise the recording pause must not fall through to the
  // real active-recording lock — a live recording on the dev machine would hold forever.
  const noRecording = () => false;

  it("returns immediately when idle and no recording is active", async () => {
    let sensorCalls = 0;
    const sensor: PressureSensor = async () => {
      sensorCalls++;
      return makePressure({ overloaded: false });
    };
    const t0 = Date.now();
    await throttleHold(throttleConfig(), makeDeadline(10_000), "test", { sensor, isRecordingActive: noRecording });
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
    await throttleHold(throttleConfig(), makeDeadline(30), "test", { sensor, isRecordingActive: noRecording });
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
      isRecordingActive: noRecording,
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

// --- P1-2 (SPEC_SAFETY_NET_2026-10-31 §3) -----------------------------------

describe("parseVmStatPageSize", () => {
  it("extracts the Apple Silicon 16384-byte page size", () => {
    assert.strictEqual(
      parseVmStatPageSize("Mach Virtual Memory Statistics: (page size of 16384 bytes)"),
      16384,
    );
  });

  it("returns null when the header is absent (older macOS wording)", () => {
    assert.strictEqual(parseVmStatPageSize("Mach Virtual Memory Statistics:\nPages free: 100."), null);
    assert.strictEqual(parseVmStatPageSize(""), null);
  });

  it("returns null for a malformed size", () => {
    assert.strictEqual(parseVmStatPageSize("(page size of 0 bytes)"), null);
  });
});

describe("parseFreeMemoryMb with a 16384-byte page header", () => {
  // The review's shape: a machine reporting ~3000 MB reclaimable, which the
  // old 4096 default under-reported as ~750 MB (4×).
  const fixture = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                          96000.
Pages inactive:                      96000.
Pages active:                        40000.
Pages wired down:                    20000.`;

  it("uses the header page size via parseVmStatPageSize → real MB", () => {
    const mb = parseFreeMemoryMb(fixture, parseVmStatPageSize(fixture)!);
    assert.strictEqual(mb, 3000); // 192000 pages × 16384 bytes
  });

  it("the same fixture via the 4096 default yields 4× less (documents the old bug)", () => {
    assert.strictEqual(parseFreeMemoryMb(fixture), 750);
  });
});

// PATH stubs for the sysctl/vm_stat children, so the default-sensor path is
// hermetic (no reliance on the host's actual load or memory).
describe("throttleHold default sensor honors configured thresholds", () => {
  let stubDir: string;
  let savedPath: string | undefined;

  const VmStatFixture = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                          100000.
Pages inactive:                      103904.
Pages active:                        40000.
Pages wired down:                    20000.`;

  function installStubs(loadavg: string): void {
    stubDir = join(tmpdir(), `meet-test-sysmon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stubDir, { recursive: true });
    const sysctl = join(stubDir, "sysctl");
    writeFileSync(sysctl, `#!/bin/sh
if [ "$1" = "-n" ] && [ "$2" = "hw.pagesize" ]; then
  echo "16384"
elif [ "$1" = "-n" ] && [ "$2" = "vm.loadavg" ]; then
  echo "${loadavg}"
fi
`, { mode: 0o755 });
    const vmStat = join(stubDir, "vm_stat");
    writeFileSync(vmStat, `#!/bin/sh\ncat <<'EOF'\n${VmStatFixture}EOF\n`, { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${savedPath ?? ""}`;
  }

  beforeEach(() => {
    _resetPageSizeCache();
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    try { rmSync(stubDir, { recursive: true, force: true }); } catch {}
    _resetPageSizeCache();
  });

  function throttleConfig(over: Partial<typeof DEFAULT_CONFIG> = {}) {
    return {
      ...DEFAULT_CONFIG,
      gateHeavyPasses: true,
      gateWhileRecording: false,
      gateLoadAvg: 0,
      gateFreeMemMb: 0,
      gatePollMs: 1,
      ...over,
    };
  }

  const noRecording = () => false;

  it("gateLoadAvg: 2 holds when the (stubbed) load is 5 — config thresholds reach the default sensor", async () => {
    installStubs("{ 5.00 5.00 5.00 }");
    // Warm the sensor once outside the gate: the first getSystemPressure call
    // spawns 4 children and its latency under concurrent test load can exceed
    // a small budget, which would fail-open before the hold branch ever runs.
    await getSystemPressure({ cpuThresholdLoad: 1e9, memThresholdMb: 0 });
    const messages: string[] = [];
    await throttleHold(
      throttleConfig({ gateLoadAvg: 2 }),
      // Budget must outlast the first in-gate sensor() call so the hold
      // branch is actually reached.
      makeDeadline(500),
      "final pass",
      { isRecordingActive: noRecording, notify: (m) => messages.push(m) },
    );
    // Pre-fix the sensor ran with DEFAULT cpuThresholdLoad (6): load 5 < 6 →
    // no hold, no message. Post-fix the configured 2 trips.
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0], /holding/);
  });

  it("gateFreeMemMb: 2048 does not hold when 3186 MB is reclaimable (16384-byte pages)", async () => {
    installStubs("{ 1.00 1.00 1.00 }");
    await getSystemPressure({ cpuThresholdLoad: 1e9, memThresholdMb: 0 });
    const messages: string[] = [];
    await throttleHold(
      throttleConfig({ gateFreeMemMb: 2048 }),
      makeDeadline(300),
      "final pass",
      { isRecordingActive: noRecording, notify: (m) => messages.push(m) },
    );
    // Pre-fix (4096 math) the same fixture read as 796 MB < 2048 → held until
    // the deadline. With the header page size it reads 3186 MB ≥ 2048 → pass.
    assert.strictEqual(messages.length, 0);
  });

  it("getSystemPressure reads free memory via the vm_stat header page size", async () => {
    installStubs("{ 1.00 1.00 1.00 }");
    const p = await getSystemPressure({ cpuThresholdLoad: 1e9, memThresholdMb: 0 });
    // 203904 pages × 16384 bytes = 3186 MB (pre-fix default: 796 MB).
    assert.strictEqual(p.freeMemoryMb, 3186);
  });
});
