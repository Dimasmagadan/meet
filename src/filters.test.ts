import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterEntries,
  isDuplicate,
  isAcknowledgement,
  normalizeForComparison,
  jaccardSimilarity,
  tokenize,
  type FinalChunkResult,
} from "./filters.js";

function makeResult(source: "mic" | "sys", index: number, text: string, rmsDb = -30): FinalChunkResult {
  return { source, index, wav: `${source}-${String(index).padStart(3, "0")}.wav`, text, rmsDb, peakDb: rmsDb + 20 };
}

describe("normalizeForComparison", () => {
  it("lowercases and strips punctuation", () => {
    assert.strictEqual(normalizeForComparison("Привет, мир!"), "привет мир");
  });

  it("replaces ё with е", () => {
    assert.strictEqual(normalizeForComparison("Всё понятно"), "все понятно");
  });

  it("collapses whitespace", () => {
    assert.strictEqual(normalizeForComparison("  а   б  "), "а б");
  });
});

describe("tokenize", () => {
  it("splits into words", () => {
    assert.deepStrictEqual(tokenize("Привет, мир!"), ["привет", "мир"]);
  });

  it("returns empty for whitespace", () => {
    assert.deepStrictEqual(tokenize("   "), []);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    assert.strictEqual(jaccardSimilarity(["а", "б"], ["а", "б"]), 1);
  });

  it("returns 0 for disjoint sets", () => {
    assert.strictEqual(jaccardSimilarity(["а"], ["б"]), 0);
  });

  it("returns 1 for two empty sets", () => {
    assert.strictEqual(jaccardSimilarity([], []), 1);
  });

  it("returns 0 for one empty set", () => {
    assert.strictEqual(jaccardSimilarity(["а"], []), 0);
  });
});

describe("isDuplicate", () => {
  it("detects exact match after normalization", () => {
    assert.strictEqual(isDuplicate("Привет, мир!", "привет мир"), true);
  });

  it("detects containment", () => {
    assert.strictEqual(isDuplicate("давайте обсудим план", "давайте обсудим план на следующую неделю"), true);
  });

  it("detects high token overlap", () => {
    assert.strictEqual(
      isDuplicate(
        "давайте обсудим квартальные цели и метрики и задачи",
        "давайте обсудим квартальные цели и метрики и планы"
      ),
      true
    );
  });

  it("rejects different text", () => {
    assert.strictEqual(isDuplicate("новый проект стартует", "старые задачи закрыты"), false);
  });
});

describe("isAcknowledgement", () => {
  it("detects single ack", () => {
    assert.strictEqual(isAcknowledgement("да"), true);
    assert.strictEqual(isAcknowledgement("ага"), true);
    assert.strictEqual(isAcknowledgement("хорошо"), true);
  });

  it("detects multi-word ack", () => {
    assert.strictEqual(isAcknowledgement("да хорошо"), true);
  });

  it("rejects longer text", () => {
    assert.strictEqual(isAcknowledgement("давайте обсудим план на сегодня"), false);
  });

  it("rejects non-ack short text", () => {
    assert.strictEqual(isAcknowledgement("проект готов"), false);
  });
});

describe("filterEntries", () => {
  const config = { micRmsThresholdDb: -60 };

  it("keeps sys-only entries", () => {
    const results = [makeResult("sys", 1, "Текст")];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].source, "sys");
  });

  it("drops quiet mic below threshold", () => {
    const results = [
      makeResult("sys", 1, "Текст"),
      makeResult("mic", 1, "Тоже текст", -80),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].source, "sys");
  });

  it("drops duplicate mic matching sys", () => {
    const results = [
      makeResult("sys", 1, "Давайте обсудим квартальные цели"),
      makeResult("mic", 1, "Давайте обсудим квартальные цели", -30),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].source, "sys");
  });

  it("drops mic acknowledgement during sys speech", () => {
    const results = [
      makeResult("sys", 1, "Нам нужно сделать презентацию к пятнице"),
      makeResult("mic", 1, "да", -30),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].source, "sys");
  });

  it("keeps strong distinct mic speech", () => {
    const results = [
      makeResult("sys", 1, "Нам нужно обновить сайт"),
      makeResult("mic", 1, "Я займусь финансовыми страницами завтра после обеда", -30),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 2);
  });

  it("keeps mic-only entries above threshold", () => {
    const results = [makeResult("mic", 1, "Я расскажу про новые фичи", -30)];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].source, "mic");
  });

  it("drops mic with 3 or fewer words when sys has text", () => {
    const results = [
      makeResult("sys", 1, "Давайте начнем с обзора"),
      makeResult("mic", 1, "начали работу сегодня", -30),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].source, "sys");
  });

  it("handles multiple indices in order", () => {
    const results = [
      makeResult("sys", 1, "Первый"),
      makeResult("mic", 1, "да", -30),
      makeResult("sys", 2, "Второй"),
      makeResult("mic", 2, "Я подготовлю отчет к вечеру", -30),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 3);
    assert.strictEqual(filtered[0].source, "sys");
    assert.strictEqual(filtered[0].index, 1);
    assert.strictEqual(filtered[1].source, "sys");
    assert.strictEqual(filtered[1].index, 2);
    assert.strictEqual(filtered[2].source, "mic");
    assert.strictEqual(filtered[2].index, 2);
  });
});
