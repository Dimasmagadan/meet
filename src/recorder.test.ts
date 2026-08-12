import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatLagStatus, planRetitle, readAskMarker } from "./recorder.js";

test("formatLagStatus: up to date when no lag", () => {
  assert.equal(formatLagStatus(0, 15, 8), "up to date");
});

test("formatLagStatus: shows plain lag below warn threshold", () => {
  assert.equal(formatLagStatus(3, 15, 8), "lag ~45s");
});

test("formatLagStatus: warns at/above threshold using the color fn", () => {
  const warned = formatLagStatus(8, 15, 8, (s) => `WARN(${s})`);
  assert.equal(warned, "WARN(lag ~120s (queue backing up))");
});

test("planRetitle: same slug as today is a no-op", () => {
  const result = planRetitle("/Meetings/2026-08-04_10-00-meeting/transcript.md", {
    title: "meeting",
    newOutputDir: "/Meetings/2026-08-04_10-00-meeting",
  });
  assert.equal(result.noop, true);
  assert.equal(result.newOutputFile, "/Meetings/2026-08-04_10-00-meeting/transcript.md");
});

test("planRetitle: new slug moves the folder, keeps the basename", () => {
  const result = planRetitle("/Meetings/2026-08-04_10-00-meeting/transcript.md", {
    title: "Standup",
    newOutputDir: "/Meetings/2026-08-04_10-00-standup",
  });
  assert.equal(result.noop, false);
  assert.equal(result.newOutputFile, "/Meetings/2026-08-04_10-00-standup/transcript.md");
});

test("planRetitle: second rename moves from the already-renamed folder", () => {
  const result = planRetitle("/Meetings/2026-08-04_10-00-standup/transcript.md", {
    title: "Standup 2",
    newOutputDir: "/Meetings/2026-08-04_10-00-standup-2",
  });
  assert.equal(result.noop, false);
  assert.equal(result.newOutputFile, "/Meetings/2026-08-04_10-00-standup-2/transcript.md");
});

// --- readAskMarker (SPEC_NOTCH_TABS_2026-08-12) ---

test("readAskMarker: returns { id, question } for a valid marker", () => {
  const dir = join(tmpdir(), `meet-ask-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "ask-request.json"), JSON.stringify({ id: "abc123", question: "What was discussed?" }), "utf-8");
    const marker = readAskMarker(dir);
    assert.deepEqual(marker, { id: "abc123", question: "What was discussed?" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskMarker: returns null and deletes when missing id or question", () => {
  const dir = join(tmpdir(), `meet-ask-mid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "ask-request.json"), JSON.stringify({ id: "abc123" }), "utf-8");
    const marker = readAskMarker(dir);
    assert.equal(marker, null);
    assert.equal(existsSync(join(dir, "ask-request.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskMarker: returns null and deletes for invalid JSON", () => {
  const dir = join(tmpdir(), `meet-ask-bad-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "ask-request.json"), "not json", "utf-8");
    const marker = readAskMarker(dir);
    assert.equal(marker, null);
    assert.equal(existsSync(join(dir, "ask-request.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskMarker: returns null when file is absent (does not throw)", () => {
  const dir = join(tmpdir(), `meet-ask-none-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const marker = readAskMarker(dir);
    assert.equal(marker, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
