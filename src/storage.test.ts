import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateSlug, formatStartTime, getOutputDir, getOutputPath, expandPath, findStaleSessions, getSessionsDir } from "./storage.js";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Session } from "./types.js";

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

  it("does not expand ~otheruser/path", () => {
    assert.strictEqual(expandPath("~otheruser/path"), "~otheruser/path");
  });

  it("expands bare ~", () => {
    const result = expandPath("~");
    assert.ok(!result.startsWith("~"));
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

describe("findStaleSessions", () => {
  const createdDirs: string[] = [];

  const makeSession = (status: Session["status"], suffix: string): string => {
    const sessionsDir = getSessionsDir();
    const sessionDir = join(sessionsDir, `meet-test-stale-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(sessionDir, { recursive: true });
    const session: Session = {
      id: suffix,
      title: "Test",
      mode: "full",
      startedAt: new Date(2026, 4, 13, 14, 30, 0).toISOString(),
      chunkDurationSeconds: 15,
      sessionDir,
      outputFile: join(sessionDir, "transcript.md"),
      capturePid: null,
      status,
      processedChunks: [],
      lastError: null,
      autoStopReason: null,
      latestProcessedOffsetSeconds: 0,
      lastMeaningfulTextAtOffsetSeconds: null,
      hasMeaningfulText: false,
      tags: [],
    };
    writeFileSync(join(sessionDir, "session.json"), JSON.stringify(session, null, 2), "utf-8");
    createdDirs.push(sessionDir);
    return sessionDir;
  };

  beforeEach(() => {
    createdDirs.length = 0;
  });

  afterEach(() => {
    for (const dir of createdDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    createdDirs.length = 0;
  });

  it("includes queued sessions", () => {
    const sessionDir = makeSession("queued", "queued");
    assert.ok(findStaleSessions().includes(sessionDir));
  });

  it("includes finalizing sessions without a live lock", () => {
    const sessionDir = makeSession("finalizing", "finalizing");
    assert.ok(findStaleSessions().includes(sessionDir));
  });

  it("includes paused sessions without a live lock", () => {
    const sessionDir = makeSession("paused", "paused");
    assert.ok(findStaleSessions().includes(sessionDir));
  });

  it("excludes recording sessions", () => {
    const sessionDir = makeSession("recording", "recording");
    assert.ok(!findStaleSessions().includes(sessionDir));
  });

  it("excludes done sessions", () => {
    const sessionDir = makeSession("done", "done");
    assert.ok(!findStaleSessions().includes(sessionDir));
  });

  it("excludes finalizing sessions with a live lock", () => {
    const sessionDir = makeSession("finalizing", "locked");
    writeFileSync(
      join(sessionDir, "finalizer.lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      "utf-8"
    );
    assert.ok(!findStaleSessions().includes(sessionDir));
  });
});
