import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLagStatus, planRetitle } from "./recorder.js";

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
