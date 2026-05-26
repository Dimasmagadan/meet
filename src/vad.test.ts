import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectSpeech } from "./vad.js";
import type { Config } from "./types.js";
import type { execFile } from "node:child_process";

type ExecFileCallback = (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

function makeExecFile(responses: Map<string, { err: NodeJS.ErrnoException | null; stdout: string }>): typeof execFile {
  return ((bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
    const key = args[args.length - 1];
    const resp = responses.get(key);
    if (resp) {
      cb(resp.err, resp.stdout, "");
    } else {
      cb(new Error("unknown"), "", "");
    }
  }) as unknown as typeof execFile;
}

const baseConfig: Config = {
  vadEnabled: true,
  vadBin: "/usr/local/bin/meet-vad",
  vadMinSpeechMs: 250,
  vadThreshold: 0.5,
  vadFailOpen: true,
  vadTimeoutMs: 30_000,
} as Config;

describe("detectSpeech", () => {
  it("returns speech:true when VAD disabled", async () => {
    const config = { ...baseConfig, vadEnabled: false, vadBin: "" };
    const result = await detectSpeech("/path/to/chunk.wav", config);
    assert.strictEqual(result.speech, true);
  });

  it("returns speech:true when helper detects speech", async () => {
    const exec = makeExecFile(new Map([
      ["/path/to/chunk.wav", { err: null, stdout: '{"speech":true,"segments":[{"startMs":100,"endMs":1400}]}' }],
    ]));
    const result = await detectSpeech("/path/to/chunk.wav", baseConfig, exec);
    assert.strictEqual(result.speech, true);
  });

  it("returns speech:false when helper detects no speech", async () => {
    const exec = makeExecFile(new Map([
      ["/path/to/chunk.wav", { err: null, stdout: '{"speech":false}' }],
    ]));
    const result = await detectSpeech("/path/to/chunk.wav", baseConfig, exec);
    assert.strictEqual(result.speech, false);
  });

  it("returns speech:true on helper failure with failOpen=true", async () => {
    const exec = makeExecFile(new Map([
      ["/path/to/chunk.wav", { err: new Error("crashed"), stdout: "" }],
    ]));
    const config = { ...baseConfig, vadFailOpen: true };
    const result = await detectSpeech("/path/to/chunk.wav", config, exec);
    assert.strictEqual(result.speech, true);
  });

  it("returns speech:false on helper failure with failOpen=false", async () => {
    const exec = makeExecFile(new Map([
      ["/path/to/chunk.wav", { err: new Error("crashed"), stdout: "" }],
    ]));
    const config = { ...baseConfig, vadFailOpen: false };
    const result = await detectSpeech("/path/to/chunk.wav", config, exec);
    assert.strictEqual(result.speech, false);
  });

  it("returns speech:true on invalid JSON with failOpen=true", async () => {
    const exec = makeExecFile(new Map([
      ["/path/to/chunk.wav", { err: null, stdout: "not json" }],
    ]));
    const config = { ...baseConfig, vadFailOpen: true };
    const result = await detectSpeech("/path/to/chunk.wav", config, exec);
    assert.strictEqual(result.speech, true);
  });

  it("returns speech:false on invalid JSON with failOpen=false", async () => {
    const exec = makeExecFile(new Map([
      ["/path/to/chunk.wav", { err: null, stdout: "not json" }],
    ]));
    const config = { ...baseConfig, vadFailOpen: false };
    const result = await detectSpeech("/path/to/chunk.wav", config, exec);
    assert.strictEqual(result.speech, false);
  });
});
