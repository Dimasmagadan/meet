import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLagStatus } from "./recorder.js";

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
