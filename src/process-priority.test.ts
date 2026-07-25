import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQoSArgs,
  applyQoS,
  isTaskpolicyAvailable,
  _resetQoSCache,
} from "./process-priority.js";

describe("buildQoSArgs", () => {
  it("wraps the command with taskpolicy -c utility when enabled + available", () => {
    const r = buildQoSArgs("/opt/homebrew/bin/whisper-cli", ["-m", "model.bin", "-f", "x.wav"], {
      enabled: true,
      available: true,
    });
    assert.strictEqual(r.applied, true);
    assert.strictEqual(r.command, "/usr/sbin/taskpolicy");
    assert.deepStrictEqual(r.args, [
      "-c",
      "utility",
      "/opt/homebrew/bin/whisper-cli",
      "-m",
      "model.bin",
      "-f",
      "x.wav",
    ]);
  });

  it("preserves flag-like args verbatim after the wrapped binary", () => {
    // taskpolicy stops option parsing at the first non-option (the binary
    // path), so a leading `-c` from the wrapped binary must survive.
    const r = buildQoSArgs("AudioAnalysis", ["-c", "transcribe", "--input", "x.wav"], {
      enabled: true,
      available: true,
    });
    assert.deepStrictEqual(r.args, ["-c", "utility", "AudioAnalysis", "-c", "transcribe", "--input", "x.wav"]);
  });

  it("returns the input unchanged when disabled by config", () => {
    const r = buildQoSArgs("whisper-cli", ["-m", "x"], { enabled: false, available: true });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(r.command, "whisper-cli");
    assert.deepStrictEqual(r.args, ["-m", "x"]);
  });

  it("returns the input unchanged when taskpolicy is unavailable (fail-open)", () => {
    const r = buildQoSArgs("whisper-cli", ["-m", "x"], { enabled: true, available: false });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(r.command, "whisper-cli");
    assert.deepStrictEqual(r.args, ["-m", "x"]);
  });
});

describe("applyQoS", () => {
  it("delegates to buildQoSArgs using the config flag + real taskpolicy presence", async () => {
    _resetQoSCache();
    const available = isTaskpolicyAvailable();
    const r = await applyQoS("whisper-cli", ["-m", "x"], { lowerProcessPriority: true });
    assert.strictEqual(r.applied, available);
    if (available) {
      assert.strictEqual(r.command, "/usr/sbin/taskpolicy");
    } else {
      assert.strictEqual(r.command, "whisper-cli");
    }
  });

  it("does not wrap when lowerProcessPriority is false even if taskpolicy exists", async () => {
    const r = await applyQoS("whisper-cli", ["-m", "x"], { lowerProcessPriority: false });
    assert.strictEqual(r.applied, false);
    assert.strictEqual(r.command, "whisper-cli");
    assert.deepStrictEqual(r.args, ["-m", "x"]);
  });
});

describe("isTaskpolicyAvailable", () => {
  it("returns a stable boolean and caches across calls", () => {
    _resetQoSCache();
    const a = isTaskpolicyAvailable();
    const b = isTaskpolicyAvailable();
    assert.strictEqual(typeof a, "boolean");
    assert.strictEqual(a, b);
  });
});
