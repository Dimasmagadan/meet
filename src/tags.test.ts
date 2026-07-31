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
  return join(sessionDir, "pending-tags.log");
}

test("hasTagCaseInsensitive: matches ignoring case", () => {
  assert.equal(hasTagCaseInsensitive(["Important", "dev"], "IMPORTANT"), true);
  assert.equal(hasTagCaseInsensitive(["Important"], "Dev"), false);
});

test("queuePendingTags: appends tag lines; dedup happens at drain", async () => {
  const dir = makeSessionDir();
  try {
    await queuePendingTags(dir, ["Tech", "tech", "Arch", "tech"]);
    assert.equal(readFileSync(pendingTagsPath(dir), "utf-8"), "Tech\ntech\nArch\ntech\n");
    assert.deepEqual(drainPendingTags(dir), ["Tech", "Arch"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queuePendingTags: concurrent calls lose no tags", async () => {
  const dir = makeSessionDir();
  try {
    await Promise.all([
      queuePendingTags(dir, ["Alpha"]),
      queuePendingTags(dir, ["beta", "Alpha", "Gamma"]),
    ]);
    const drained = drainPendingTags(dir);
    assert.deepEqual(new Set(drained), new Set(["Alpha", "beta", "Gamma"]));
    assert.equal(existsSync(pendingTagsPath(dir)), false);
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
