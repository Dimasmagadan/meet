import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { modelAlias, resolveModelInput, contractHome, ModelNotFoundError, type ModelFileInfo } from "./model-select.js";

function file(name: string): ModelFileInfo {
  return { name, path: join("/models", name), alias: modelAlias(name), sizeMb: 100 };
}

const FILES = [
  file("ggml-small.bin"),
  file("ggml-medium.bin"),
  file("ggml-large-v3-q5_0.bin"),
  file("ggml-large-v3-turbo-q5_0.bin"),
];

describe("modelAlias", () => {
  it("prefers turbo over large for turbo filenames", () => {
    assert.strictEqual(modelAlias("ggml-large-v3-turbo-q5_0.bin"), "turbo");
  });

  it("maps the classic models to their size aliases", () => {
    assert.strictEqual(modelAlias("ggml-large-v3-q5_0.bin"), "large");
    assert.strictEqual(modelAlias("ggml-medium.bin"), "medium");
    assert.strictEqual(modelAlias("ggml-small.bin"), "small");
    assert.strictEqual(modelAlias("ggml-tiny.en.bin"), "tiny");
  });

  it("falls back to the de-prefixed stem for unknown names", () => {
    assert.strictEqual(modelAlias("ggml-custom-voice.bin"), "custom-voice");
  });
});

describe("resolveModelInput", () => {
  it("resolves a unique alias", () => {
    assert.strictEqual(resolveModelInput("turbo", FILES), "/models/ggml-large-v3-turbo-q5_0.bin");
    assert.strictEqual(resolveModelInput("SMALL", FILES), "/models/ggml-small.bin");
  });

  it("resolves an exact file name with or without the .bin suffix", () => {
    assert.strictEqual(resolveModelInput("ggml-medium", FILES), "/models/ggml-medium.bin");
    assert.strictEqual(resolveModelInput("ggml-medium.bin", FILES), "/models/ggml-medium.bin");
  });

  it("resolves a unique substring", () => {
    assert.strictEqual(resolveModelInput("turbo-q5", FILES), "/models/ggml-large-v3-turbo-q5_0.bin");
  });

  it("accepts an existing absolute path", () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-models-"));
    try {
      const real = join(dir, "ggml-real.bin");
      writeFileSync(real, "");
      assert.strictEqual(resolveModelInput(real, FILES), real);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-existent absolute path", () => {
    assert.throws(() => resolveModelInput("/models/nope.bin", FILES), ModelNotFoundError);
  });

  it("rejects an ambiguous alias listing the candidates", () => {
    const files = [file("ggml-large-fp16.bin"), file("ggml-large-q5_0.bin")];
    assert.throws(() => resolveModelInput("large", files), /ambiguous.*ggml-large-fp16\.bin, ggml-large-q5_0\.bin/);
  });

  it("rejects an unknown alias listing the available ones", () => {
    assert.throws(() => resolveModelInput("nano", FILES), /no model matches "nano".*small, medium, large, turbo/);
  });
});

describe("contractHome", () => {
  it("contracts paths under homedir to ~/ form", () => {
    assert.strictEqual(contractHome(join(homedir(), "x/y")), "~/x/y");
  });

  it("leaves other paths untouched", () => {
    assert.strictEqual(contractHome("/usr/local/share/x"), "/usr/local/share/x");
  });
});
