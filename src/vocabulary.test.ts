import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Vocabulary } from "./vocabulary.js";
import { writeFileSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `meet-test-vocabulary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTerms(path: string, terms: unknown[]) {
  writeFileSync(path, JSON.stringify({ terms }), "utf-8");
}

describe("Vocabulary", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it("identity mode when file missing", () => {
    const v = Vocabulary.load(join(tmpDir, "missing.json"));
    assert.deepStrictEqual(v.terms, []);
    assert.strictEqual(v.toPromptSuffix("base"), "");
    assert.strictEqual(v.termCount, 0);
  });

  it("identity mode when invalid JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ not valid json", "utf-8");
    const v = Vocabulary.load(path);
    assert.deepStrictEqual(v.terms, []);
    assert.strictEqual(v.toPromptSuffix("base"), "");
  });

  it("identity mode when terms empty", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, []);
    const v = Vocabulary.load(path);
    assert.deepStrictEqual(v.terms, []);
    assert.strictEqual(v.toPromptSuffix("base"), "");
  });

  it("loads valid terms preserving file order", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Acme", "Smith", "ScreenCaptureKit"]);
    const v = Vocabulary.load(path);
    assert.deepStrictEqual(v.terms, ["Acme", "Smith", "ScreenCaptureKit"]);
    assert.strictEqual(v.termCount, 3);
  });

  it("trims whitespace and skips empty/non-string entries", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["  Дим  ", "", "   ", 123, null, {}, "Яна"]);
    const v = Vocabulary.load(path);
    assert.deepStrictEqual(v.terms, ["Дим", "Яна"]);
  });

  it("toPromptSuffix produces '. Термины: a, b, c' format", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Acme", "Smith"]);
    const v = Vocabulary.load(path);
    assert.strictEqual(v.toPromptSuffix("base"), ". Термины: Acme, Smith");
  });

  it("toPromptSuffix returns '' when no terms", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, []);
    const v = Vocabulary.load(path);
    assert.strictEqual(v.toPromptSuffix("base"), "");
  });

  it("toPromptSuffix folds extraTerms (calendar attendees) in after file terms", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Acme"]);
    const v = Vocabulary.load(path);
    assert.strictEqual(
      v.toPromptSuffix("base", 200, ["Anna Petrova", "Ivan S."]),
      ". Термины: Acme, Anna Petrova, Ivan S.",
    );
  });

  it("toPromptSuffix uses extraTerms alone when the vocabulary file has no terms", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, []);
    const v = Vocabulary.load(path);
    assert.strictEqual(v.toPromptSuffix("base", 200, ["Anna Petrova"]), ". Термины: Anna Petrova");
  });

  it("toPromptSuffix truncates extraTerms once the shared budget runs out, file terms first", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["ааа"]);
    const v = Vocabulary.load(path);
    // budget only fits the prefix + file term, not the attendee that follows.
    const suffix = v.toPromptSuffix("x".repeat(10), 10 + ". Термины: ".length + "ааа".length, ["очень-длинное-имя-участника"]);
    assert.strictEqual(suffix, ". Термины: ааа");
  });

  it("toPromptSuffix returns '' when basePrompt alone meets budget", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Дим"]);
    const v = Vocabulary.load(path);
    const base = "x".repeat(200);
    assert.strictEqual(v.toPromptSuffix(base), "");
  });

  it("toPromptSuffix returns '' when budget too small for prefix", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Дим"]);
    const v = Vocabulary.load(path);
    // basePrompt leaves room but not enough for ". Термины: " prefix
    assert.strictEqual(v.toPromptSuffix("x".repeat(195), 200), "");
  });

  it("toPromptSuffix truncates deterministically — first terms win", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["ааа", "ббб", "ввв", "ггг", "ддд"]);
    const v = Vocabulary.load(path);
    // base="x"*10, budget 200 → 190 chars for suffix, prefix ". Термины: " (10 chars, Cyrillic "Термины" is 7 chars but chars counted by length)
    const suffix = v.toPromptSuffix("x".repeat(10), 50);
    // budget=40, prefix length = ". Термины: ".length (10) + cyrillic chars... compute by structure:
    // remaining = 40 - 10 = 30; terms "ааа"(3)+", "(2)+"ббб"(3)+", "(2)+"ввв"(3)=13 ... fits several
    // just assert it starts with prefix and is a strict prefix of the full join
    assert.ok(suffix.startsWith(". Термины: "));
    assert.ok(suffix.length <= 40);
    const full = v.toPromptSuffix("x".repeat(10), 1000);
    assert.ok(full.startsWith(suffix.split("").slice(0, suffix.length).join("")));
    assert.ok(full.length >= suffix.length);
  });

  it("toPromptSuffix uses default cap of 200", () => {
    const path = join(tmpDir, "v.json");
    const longTerms = Array.from({ length: 50 }, (_, i) => `термин${i}`);
    writeTerms(path, longTerms);
    const v = Vocabulary.load(path);
    const suffix = v.toPromptSuffix("короткая база");
    assert.ok(suffix.length <= 200 - "короткая база".length);
    assert.ok(suffix.startsWith(". Термины: "));
  });

  it("terms getter returns a defensive copy", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Дим"]);
    const v = Vocabulary.load(path);
    const t = v.terms;
    t.push("mutated");
    assert.deepStrictEqual(v.terms, ["Дим"]);
  });

  it("maybeReload returns false when file unchanged", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Дим"]);
    const v = Vocabulary.load(path);
    assert.strictEqual(v.maybeReload(), false);
  });

  it("maybeReload returns true and applies new terms after file change", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Дим"]);
    const v = Vocabulary.load(path);
    assert.deepStrictEqual(v.terms, ["Дим"]);

    const oldMtime = statSync(path).mtimeMs;
    const newMtime = oldMtime + 2000;
    utimesSync(path, newMtime / 1000, newMtime / 1000);
    writeTerms(path, ["Яна"]);

    assert.strictEqual(v.maybeReload(), true);
    assert.deepStrictEqual(v.terms, ["Яна"]);
  });

  it("maybeReload returns false when file deleted", () => {
    const path = join(tmpDir, "v.json");
    writeTerms(path, ["Дим"]);
    const v = Vocabulary.load(path);
    rmSync(path);
    assert.strictEqual(v.maybeReload(), false);
  });
});
