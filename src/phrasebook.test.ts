import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Phrasebook } from "./phrasebook.js";
import { writeFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `meet-test-phrasebook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePhrasebook(path: string, rules: Array<{ from: string; to: string; caseInsensitive?: boolean; wordBoundary?: boolean }>) {
  writeFileSync(path, JSON.stringify({ replacements: rules }), "utf-8");
}

describe("Phrasebook", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it("identity mode when file missing", () => {
    const pb = Phrasebook.load(join(tmpDir, "missing.json"));
    assert.strictEqual(pb.apply("любой текст"), "любой текст");
    assert.strictEqual(pb.ruleCount, 0);
  });

  it("identity mode when replacements empty", () => {
    const path = join(tmpDir, "p.json");
    writeFileSync(path, JSON.stringify({ replacements: [] }), "utf-8");
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("текст"), "текст");
  });

  it("identity mode when invalid JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ not valid json", "utf-8");
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("текст"), "текст");
  });

  it("applies simple replacement", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "j join", to: "ajs_join" }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("Используем j join к таблице"), "Используем ajs_join к таблице");
  });

  it("applies case-insensitive replacement", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "дифон", to: "Daffon", caseInsensitive: true }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("Это Дифон работает"), "Это Daffon работает");
    assert.strictEqual(pb.apply("дифон тут же"), "Daffon тут же");
  });

  it("applies word-boundary replacement", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "join", to: "JOIN", wordBoundary: true }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("сделали join тут"), "сделали JOIN тут");
    assert.strictEqual(pb.apply("joining таблицы"), "joining таблицы");
  });

  it("applies rules in file order", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [
      { from: "foo bar", to: "FIRST" },
      { from: "foo", to: "SECOND" },
    ]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("foo bar baz"), "FIRST baz");
  });

  it("skips rule with empty from", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "", to: "something" }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.ruleCount, 0);
  });

  it("maybeReload returns false when file unchanged", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "a", to: "b" }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.maybeReload(), false);
  });

  it("maybeReload returns true and applies new rules after file change", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "foo", to: "bar" }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("foo"), "bar");

    const oldMtime = statSync(path).mtimeMs;
    const newMtime = oldMtime + 2000;
    utimesSync(path, newMtime / 1000, newMtime / 1000);
    writePhrasebook(path, [{ from: "foo", to: "BAZ" }]);

    assert.strictEqual(pb.maybeReload(), true);
    assert.strictEqual(pb.apply("foo"), "BAZ");
  });

  it("maybeReload returns false when file deleted", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "a", to: "b" }]);
    const pb = Phrasebook.load(path);
    rmSync(path);
    assert.strictEqual(pb.maybeReload(), false);
  });
});
