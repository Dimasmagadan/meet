import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Phrasebook, RAW_REGEX_SANITY_CAP } from "./phrasebook.js";
import { writeFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `meet-test-phrasebook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePhrasebook(path: string, rules: Array<{ from: string; to: string; caseInsensitive?: boolean; wordBoundary?: boolean; regex?: boolean }>) {
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

  it("regex rule applies raw pattern", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "colou?r", to: "COLOR", regex: true }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("the colour and color"), "the COLOR and COLOR");
  });

  it("regex rule resolves $1/$2 backrefs", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "(foo)\\s+(bar)", to: "$2 $1", regex: true }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("foo bar here"), "bar foo here");
  });

  it("regex rule honors caseInsensitive", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "hello", to: "HI", regex: true, caseInsensitive: true }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("HELLO hello HeLLo"), "HI HI HI");
  });

  it("regex rule ignores wordBoundary (incompatible with raw pattern)", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "foo.*bar", to: "X", regex: true, wordBoundary: true }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("start foobarbaz end"), "start Xbaz end");
  });

  it("regex rule with invalid pattern is skipped", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [
      { from: "(unclosed", to: "BAD", regex: true },
      { from: "ok", to: "OK", regex: true },
    ]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.ruleCount, 1);
    assert.strictEqual(pb.apply("ok here"), "OK here");
  });

  it("regex rule with pattern at sanity cap boundary", () => {
    const path = join(tmpDir, "p.json");
    const ok = "a".repeat(RAW_REGEX_SANITY_CAP - 1);
    const tooLong = "a".repeat(RAW_REGEX_SANITY_CAP);
    writePhrasebook(path, [
      { from: ok, to: "OK", regex: true },
      { from: tooLong, to: "SKIP", regex: true },
    ]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.ruleCount, 1);
    assert.strictEqual(pb.apply(ok), "OK");
    assert.strictEqual(pb.apply(tooLong), "OKa");
  });

  it("regex rule that matches empty string is skipped (would mangle every chunk)", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [
      { from: "a*", to: "X", regex: true },
      { from: "ok", to: "OK", regex: true },
    ]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.ruleCount, 1);
    assert.strictEqual(pb.apply("bcd"), "bcd");
    assert.strictEqual(pb.apply("ok"), "OK");
  });

  it("regex rule with alternation containing empty branch is skipped", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [{ from: "foo|", to: "X", regex: true }]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.ruleCount, 0);
    assert.strictEqual(pb.apply("anything"), "anything");
  });

  it("literal rules still work alongside regex rules", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [
      { from: "join", to: "JOIN", wordBoundary: true },
      { from: "(\\d+)-(\\d+)", to: "$2/$1", regex: true },
    ]);
    const pb = Phrasebook.load(path);
    assert.strictEqual(pb.apply("join 12-34"), "JOIN 34/12");
  });

  it("Bitrix URL rule: номер задачи 1234 → full URL", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [
      {
        from: "(номер\\s+задачи(?:\\s+в\\s+битриксе)?[^0-9А-Яа-яЁё]{0,8})(\\d{2,})",
        to: "$1https://sam.optimacros.com/workgroups/group/64/tasks/task/view/$2/",
        regex: true,
        caseInsensitive: true,
      },
    ]);
    const pb = Phrasebook.load(path);
    const expected = "посмотри номер задачи https://sam.optimacros.com/workgroups/group/64/tasks/task/view/1234/ пожалуйста";
    assert.strictEqual(pb.apply("посмотри номер задачи 1234 пожалуйста"), expected);
  });

  it("Bitrix URL rule: номер задачи в битриксе 1234 → full URL", () => {
    const path = join(tmpDir, "p.json");
    writePhrasebook(path, [
      {
        from: "(номер\\s+задачи(?:\\s+в\\s+битриксе)?[^0-9А-Яа-яЁё]{0,8})(\\d{2,})",
        to: "$1https://sam.optimacros.com/workgroups/group/64/tasks/task/view/$2/",
        regex: true,
        caseInsensitive: true,
      },
    ]);
    const pb = Phrasebook.load(path);
    const out = pb.apply("номер задачи в битриксе 5678 готов");
    assert.match(out, /^номер задачи в битриксе https:\/\/sam\.optimacros\.com.+5678\/ готов$/);
  });
});
