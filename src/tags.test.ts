import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queuePendingTags, drainPendingTags, hasTagCaseInsensitive } from "./tags.js";

function makeSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "meet-tags-"));
}

function pendingTagsPath(sessionDir: string): string {
  return join(sessionDir, "pending-tags.json");
}

test("hasTagCaseInsensitive: matches ignoring case", () => {
  assert.equal(hasTagCaseInsensitive(["Important", "dev"], "IMPORTANT"), true);
  assert.equal(hasTagCaseInsensitive(["Important"], "Dev"), false);
});

test("queuePendingTags: writes a JSON array, dedups case-insensitively", async () => {
  const dir = makeSessionDir();
  try {
    await queuePendingTags(dir, ["Tech", "tech", "Arch", "tech"]);
    const raw = JSON.parse(readFileSync(pendingTagsPath(dir), "utf-8"));
    assert.deepEqual(raw, ["Tech", "Arch"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queuePendingTags: merges across two calls before a drain", async () => {
  const dir = makeSessionDir();
  try {
    await queuePendingTags(dir, ["One"]);
    await queuePendingTags(dir, ["two", "One", "Two"]);
    const raw = JSON.parse(readFileSync(pendingTagsPath(dir), "utf-8"));
    assert.deepEqual(raw, ["One", "two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drainPendingTags: returns queued tags and removes the inbox", async () => {
  const dir = makeSessionDir();
  try {
    await queuePendingTags(dir, ["One", "two"]);
    assert.deepEqual(drainPendingTags(dir), ["One", "two"]);
    assert.equal(existsSync(pendingTagsPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drainPendingTags: returns [] with no inbox file", () => {
  const dir = makeSessionDir();
  try {
    assert.deepEqual(drainPendingTags(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drainPendingTags: drain-then-empty returns []", async () => {
  const dir = makeSessionDir();
  try {
    await queuePendingTags(dir, ["One"]);
    drainPendingTags(dir);
    assert.deepEqual(drainPendingTags(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
