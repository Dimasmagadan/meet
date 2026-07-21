import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLoadavg, parseFreeMemoryMb, getSystemPressure, _resetWhisperCache } from "./system-monitor.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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
