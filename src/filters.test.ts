import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterEntries,
  isDuplicate,
  isAcknowledgement,
  normalizeForComparison,
  jaccardSimilarity,
  coverageRatio,
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

describe("coverageRatio", () => {
  it("returns 1 when all mic tokens are covered", () => {
    assert.strictEqual(coverageRatio(["а", "б"], new Set(["а", "б", "в"])), 1);
  });

  it("returns 0 for an empty neighbourhood", () => {
    assert.strictEqual(coverageRatio(["а", "б"], new Set()), 0);
  });

  it("returns 0 for empty mic tokens", () => {
    assert.strictEqual(coverageRatio([], new Set(["а"])), 0);
  });

  it("is not dragged down by neighbourhood-only tokens (asymmetric)", () => {
    // sys neighbourhood has lots of extra material mic never said — coverage
    // stays 1 as long as every mic token is present, unlike symmetric Jaccard.
    const sysNeighbourhood = new Set(["а", "б", "в", "г", "д", "е", "ж", "з"]);
    assert.strictEqual(coverageRatio(["а", "б"], sysNeighbourhood), 1);
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

  it("drops mic echo whose leading sentence lives in sys N-1 (row 2)", () => {
    // Signature of window misalignment: mic-2 carries a leading sentence that
    // sys already emitted in chunk 1, which tanks symmetric Jaccard against
    // sys-2 alone but is fully covered by the {N-1,N,N+1} neighbourhood.
    const results = [
      makeResult("sys", 1, "У нас он разделялась по правильным источникам"),
      makeResult("sys", 2, "У нас есть мероприятие FUN мероприятие онлайн ХАП сейчас приходит"),
      makeResult(
        "mic",
        2,
        "У нас он разделялась по правильным источникам У нас есть мероприятие онлайн ХАП сейчас приходит",
        -30
      ),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.filter((r) => r.source === "mic").length, 0);
  });

  it("keeps a genuinely distinct mic topic even with neighbourhood text present (row 4)", () => {
    const results = [
      makeResult("sys", 1, "Или по какому-то другому и ты там передаешь отдельно"),
      makeResult("mic", 1, "Сейчас разделения на онлайн офлайн в коде нет вообще никакого", -30),
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.length, 2);
  });

  it("drops mic entries flagged by micEchoScore (P2) even without text overlap", () => {
    const results = [
      makeResult("sys", 1, "Что-то сказанное в динамики"),
      { ...makeResult("mic", 1, "Совершенно другой текст без пересечения слов", -30), micEchoScore: 0.95 },
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.filter((r) => r.source === "mic").length, 0);
  });

  it("keeps mic entries when micEchoScore is below the fraction threshold", () => {
    const results = [
      makeResult("sys", 1, "Что-то сказанное в динамики"),
      { ...makeResult("mic", 1, "Я лично добавил кое-что важное сюда", -30), micEchoScore: 0.2 },
    ];
    const filtered = filterEntries(results, config);
    assert.strictEqual(filtered.filter((r) => r.source === "mic").length, 1);
  });

  it("populates the droppedEcho accumulator for a coverage drop (row 1: Jaccard just misses, coverage catches it)", () => {
    const droppedEcho: FinalChunkResult[] = [];
    const results = [
      makeResult("sys", 1, "Привет Здорово Мы хотели уточнить у тебя по разделу мероприятия"),
      makeResult("mic", 1, "Всем привет Мы хотели уточнить тебя по разделу мероприятия", -30),
    ];
    filterEntries(results, config, droppedEcho);
    assert.strictEqual(droppedEcho.length, 1);
    assert.strictEqual(droppedEcho[0].source, "mic");
  });

  it("populates the droppedEcho accumulator for a micEchoScore drop", () => {
    const droppedEcho: FinalChunkResult[] = [];
    const results = [
      makeResult("sys", 1, "Что-то сказанное в динамики"),
      { ...makeResult("mic", 1, "Совершенно другой текст без пересечения слов", -30), micEchoScore: 0.95 },
    ];
    filterEntries(results, config, droppedEcho);
    assert.strictEqual(droppedEcho.length, 1);
    assert.strictEqual(droppedEcho[0].source, "mic");
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
