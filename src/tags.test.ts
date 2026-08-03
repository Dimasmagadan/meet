import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTagsState, readTagsState, hasTagCaseInsensitive } from "./tags.js";

function makeSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "meet-tags-"));
}

function tagsStatePath(sessionDir: string): string {
  return join(sessionDir, "tags-state.json");
}

test("hasTagCaseInsensitive: matches ignoring case", () => {
  assert.equal(hasTagCaseInsensitive(["Important", "dev"], "IMPORTANT"), true);
  assert.equal(hasTagCaseInsensitive(["Important"], "Dev"), false);
});

test("writeTagsState: persists a dedup'd snapshot", async () => {
  const dir = makeSessionDir();
  try {
    await writeTagsState(dir, ["Tech", "tech", "Arch", "tech"]);
    const raw = JSON.parse(readFileSync(tagsStatePath(dir), "utf-8"));
    assert.deepEqual(raw.tags, ["Tech", "Arch"]);
    assert.deepEqual(readTagsState(dir), ["Tech", "Arch"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTagsState: a later write fully replaces the previous selection", async () => {
  const dir = makeSessionDir();
  try {
    await writeTagsState(dir, ["work", "personal"]);
    await writeTagsState(dir, ["work"]); // "personal" unchecked
    assert.deepEqual(readTagsState(dir), ["work"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTagsState: writing [] clears the selection", async () => {
  const dir = makeSessionDir();
  try {
    await writeTagsState(dir, ["work"]);
    await writeTagsState(dir, []);
    assert.deepEqual(readTagsState(dir), []);
    assert.equal(existsSync(tagsStatePath(dir)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTagsState: returns [] with no state file", () => {
  const dir = makeSessionDir();
  try {
    assert.deepEqual(readTagsState(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTagsState: returns [] on malformed JSON", async () => {
  const dir = makeSessionDir();
  try {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tagsStatePath(dir), "{not json", "utf-8");
    assert.deepEqual(readTagsState(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Models the menu-bar pickers end-to-end: mid-call "Add Tag…" writes the full
// selection, and the Stop dialog (or a second "Add Tag…") reads that same state to
// pre-check its boxes — whatever it submits (even untouched) becomes the new state.
test("tag selected mid-call survives untouched through a later picker submit", async () => {
  const dir = makeSessionDir();
  try {
    await writeTagsState(dir, ["work"]); // mid-call "Add Tag…"

    const preChecked = readTagsState(dir); // next picker (Stop, or Add Tag again) pre-checks from this
    assert.deepEqual(preChecked, ["work"]);

    await writeTagsState(dir, preChecked); // user submits with the checkbox left untouched

    assert.deepEqual(readTagsState(dir), ["work"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("picker: pre-checked tag plus a newly-typed tag both survive to the final state", async () => {
  const dir = makeSessionDir();
  try {
    await writeTagsState(dir, ["work"]); // mid-call "Add Tag…"

    const preChecked = readTagsState(dir);
    const selected = [...preChecked, "followup"]; // checkbox left checked + new tag typed
    await writeTagsState(dir, selected);

    assert.deepEqual(readTagsState(dir), ["work", "followup"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("picker: unchecking a pre-checked tag removes it from the final state", async () => {
  const dir = makeSessionDir();
  try {
    await writeTagsState(dir, ["work", "personal"]);

    const preChecked = readTagsState(dir);
    const selected = preChecked.filter((t) => t !== "personal"); // user unchecks "personal"
    await writeTagsState(dir, selected);

    assert.deepEqual(readTagsState(dir), ["work"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
