import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Triggers } from "./triggers.js";
import { writeFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `meet-test-triggers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTriggers(path: string, triggers: unknown[]) {
  writeFileSync(path, JSON.stringify({ triggers }), "utf-8");
}

describe("Triggers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it("identity mode when file missing", () => {
    const t = Triggers.load(join(tmpDir, "missing.json"));
    assert.strictEqual(t.match("любой текст"), null);
    assert.strictEqual(t.triggerCount, 0);
  });

  it("identity mode when invalid JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ not valid json", "utf-8");
    const t = Triggers.load(path);
    assert.strictEqual(t.match("текст"), null);
    assert.strictEqual(t.triggerCount, 0);
  });

  it("identity mode when triggers empty", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, []);
    const t = Triggers.load(path);
    assert.strictEqual(t.match("текст"), null);
    assert.strictEqual(t.triggerCount, 0);
  });

  it("case-insensitive Cyrillic match", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим"]);
    const t = Triggers.load(path);
    const m = t.match("Слушай, дим, скажи что думаешь");
    assert.ok(m);
    assert.strictEqual(m!.trigger, "Дим");
  });

  it("stem mid-word match", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим"]);
    const t = Triggers.load(path);
    const m = t.match("Диму сказали позвонить");
    assert.ok(m);
    assert.strictEqual(m!.trigger, "Дим");
  });

  it("snippet includes ellipsis when match is not near text boundaries", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим"]);
    const t = Triggers.load(path);
    const padding = "а".repeat(60);
    const text = `${padding} Дим ${padding}`;
    const m = t.match(text);
    assert.ok(m);
    assert.ok(m!.snippet.startsWith("…"));
    assert.ok(m!.snippet.endsWith("…"));
  });

  it("snippet has no ellipsis when match is at text boundaries", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим"]);
    const t = Triggers.load(path);
    const m = t.match("Дим, ты тут?");
    assert.ok(m);
    assert.strictEqual(m!.snippet.startsWith("…"), false);
    assert.strictEqual(m!.snippet.endsWith("…"), false);
  });

  it("skips non-string entries", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, [123, null, {}, "Дим"]);
    const t = Triggers.load(path);
    assert.strictEqual(t.triggerCount, 1);
  });

  it("first-of-several triggers wins", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим", "сказали"]);
    const t = Triggers.load(path);
    const m = t.match("Диму сказали позвонить");
    assert.ok(m);
    assert.strictEqual(m!.trigger, "Дим");
  });

  it("maybeReload returns false when file unchanged", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим"]);
    const t = Triggers.load(path);
    assert.strictEqual(t.maybeReload(), false);
  });

  it("maybeReload returns true and applies new triggers after file change", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим"]);
    const t = Triggers.load(path);
    assert.ok(t.match("Дим тут"));

    const oldMtime = statSync(path).mtimeMs;
    const newMtime = oldMtime + 2000;
    utimesSync(path, newMtime / 1000, newMtime / 1000);
    writeTriggers(path, ["Яна"]);

    assert.strictEqual(t.maybeReload(), true);
    assert.strictEqual(t.match("Дим тут"), null);
    assert.ok(t.match("Яна тут"));
  });

  it("maybeReload returns false when file deleted", () => {
    const path = join(tmpDir, "t.json");
    writeTriggers(path, ["Дим"]);
    const t = Triggers.load(path);
    rmSync(path);
    assert.strictEqual(t.maybeReload(), false);
  });
});
