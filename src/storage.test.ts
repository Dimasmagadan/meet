import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSlug, formatStartTime, getOutputDir, getOutputPath, expandPath } from "./storage.js";
import { join } from "node:path";

describe("generateSlug", () => {
  it("lowercases English title", () => {
    assert.strictEqual(generateSlug("Weekly Standup"), "weekly-standup");
  });

  it("preserves Russian characters", () => {
    assert.strictEqual(generateSlug("План на квартал"), "план-на-квартал");
  });

  it("removes punctuation", () => {
    assert.strictEqual(generateSlug("Review: Q3 '26"), "review-q3-26");
  });

  it("collapses repeated dashes", () => {
    assert.strictEqual(generateSlug("a -- b"), "a-b");
  });

  it("collapses repeated spaces", () => {
    assert.strictEqual(generateSlug("a   b"), "a-b");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    assert.strictEqual(generateSlug(long).length, 60);
  });

  it("handles empty string", () => {
    assert.strictEqual(generateSlug(""), "");
  });
});

describe("formatStartTime", () => {
  it("formats date as YYYY-MM-DD_HH-MM", () => {
    const d = new Date(2026, 4, 13, 14, 30);
    assert.strictEqual(formatStartTime(d), "2026-05-13_14-30");
  });

  it("pads single-digit month/day/hour/minute", () => {
    const d = new Date(2026, 0, 5, 9, 7);
    assert.strictEqual(formatStartTime(d), "2026-01-05_09-07");
  });
});

describe("expandPath", () => {
  it("expands tilde", () => {
    const result = expandPath("~/test");
    assert.ok(!result.startsWith("~"));
    assert.ok(result.includes("test"));
  });

  it("leaves absolute path unchanged", () => {
    assert.strictEqual(expandPath("/tmp/test"), "/tmp/test");
  });

  it("leaves relative path unchanged", () => {
    assert.strictEqual(expandPath("relative/path"), "relative/path");
  });
});

describe("getOutputDir", () => {
  const config = { outputDir: "/tmp/Meetings", chunkDurationSeconds: 30 } as any;

  it("produces expected format", () => {
    const d = new Date(2026, 4, 13, 14, 30);
    const result = getOutputDir(config, "Weekly Standup", d);
    assert.strictEqual(result, "/tmp/Meetings/2026-05-13_14-30-weekly-standup");
  });
});

describe("getOutputPath", () => {
  const config = { outputDir: "/tmp/Meetings", chunkDurationSeconds: 30 } as any;

  it("appends transcript.md", () => {
    const d = new Date(2026, 4, 13, 14, 30);
    const result = getOutputPath(config, "Meeting", d);
    assert.ok(result.endsWith("/transcript.md"));
    assert.ok(result.includes("2026-05-13_14-30-meeting"));
  });
});
