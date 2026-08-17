import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkFileRegex, sortChunkFilenames, MIC_OR_SYS_CHUNK_RE } from "./regex-utils.js";

describe("chunkFileRegex", () => {
  it("matches any digit width, not just 3", () => {
    assert.ok(chunkFileRegex("mic").test("mic-1.wav"));
    assert.ok(chunkFileRegex("mic").test("mic-001.wav"));
    assert.ok(chunkFileRegex("mic").test("mic-1000.wav"));
  });

  it("rejects the other prefix", () => {
    assert.ok(!chunkFileRegex("mic").test("sys-001.wav"));
  });

  it("captures the index when requested", () => {
    const match = chunkFileRegex("sys", true).exec("sys-1042.wav");
    assert.strictEqual(match?.[1], "1042");
  });
});

describe("MIC_OR_SYS_CHUNK_RE", () => {
  it("matches both prefixes at any digit width", () => {
    assert.deepStrictEqual(MIC_OR_SYS_CHUNK_RE.exec("sys-1000.wav")?.slice(1), ["sys", "1000"]);
  });
});

describe("sortChunkFilenames", () => {
  it("sorts numerically past the 999/1000 boundary, unlike string sort", () => {
    const files = ["mic-1000.wav", "mic-999.wav", "mic-001.wav", "mic-2.wav"];
    assert.deepStrictEqual(sortChunkFilenames(files), [
      "mic-001.wav",
      "mic-2.wav",
      "mic-999.wav",
      "mic-1000.wav",
    ]);
  });

  it("does not mutate the input array", () => {
    const files = ["mic-002.wav", "mic-001.wav"];
    const copy = [...files];
    sortChunkFilenames(files);
    assert.deepStrictEqual(files, copy);
  });
});
