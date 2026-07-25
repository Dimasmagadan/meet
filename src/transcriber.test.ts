import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChunkFilename, cleanText } from "./transcriber.js";

describe("parseChunkFilename", () => {
  it("parses mic-001.wav", () => {
    assert.deepStrictEqual(parseChunkFilename("mic-001.wav"), { source: "mic", index: 1 });
  });

  it("parses sys-123.wav", () => {
    assert.deepStrictEqual(parseChunkFilename("sys-123.wav"), { source: "sys", index: 123 });
  });

  it("parses mic-009.wav", () => {
    assert.deepStrictEqual(parseChunkFilename("mic-009.wav"), { source: "mic", index: 9 });
  });

  it("rejects mic-1.wav (non-zero-padded)", () => {
    assert.strictEqual(parseChunkFilename("mic-1.wav"), null);
  });

  it("rejects foo-001.wav", () => {
    assert.strictEqual(parseChunkFilename("foo-001.wav"), null);
  });

  it("rejects mic-001.wav.tmp", () => {
    assert.strictEqual(parseChunkFilename("mic-001.wav.tmp"), null);
  });

  it("rejects mic-abc.wav", () => {
    assert.strictEqual(parseChunkFilename("mic-abc.wav"), null);
  });

  it("rejects empty string", () => {
    assert.strictEqual(parseChunkFilename(""), null);
  });

  it("rejects plain .wav", () => {
    assert.strictEqual(parseChunkFilename(".wav"), null);
  });
});

describe("cleanText", () => {
  it("removes bracket noise", () => {
    assert.strictEqual(cleanText("[music] Привет"), "Привет");
  });

  it("removes parenthetical noise", () => {
    assert.strictEqual(cleanText("(applause) Привет"), "Привет");
  });

  it("removes music symbols", () => {
    assert.strictEqual(cleanText("♪ Привет ♫"), "Привет");
  });

  it("removes hallucination: спасибо за просмотр", () => {
    const result = cleanText("Спасибо за просмотр. Давайте обсудим план.");
    assert.ok(!result.includes("Спасибо за просмотр"));
    assert.ok(result.includes("Давайте обсудим план"));
  });

  it("removes hallucination: подписывайтесь", () => {
    const result = cleanText("Подписывайтесь на канал! Итак, по проекту.");
    assert.ok(!result.includes("Подписывайтесь"));
  });

  it("removes hallucination: встреча на русском языке (prompt leak)", () => {
    assert.strictEqual(cleanText("Встреча на русском языке."), "");
  });

  it("removes prompt leak mixed with other text", () => {
    const result = cleanText("Встреча на русском языке. Давайте начнём.");
    assert.ok(!result.includes("Встреча на русском"));
    assert.ok(result.includes("Давайте начнём"));
  });

  it("keeps valid business text", () => {
    const text = "Давайте обсудим квартальные цели и метрики.";
    assert.strictEqual(cleanText(text), text);
  });

  it("collapses repeated words (3+ identical consecutive)", () => {
    assert.strictEqual(cleanText("да да да да"), "да");
    assert.strictEqual(cleanText("ну ну ну хорошо"), "ну хорошо");
  });

  it("collapses ellipsis sequences", () => {
    assert.strictEqual(cleanText("Привет.... Мир"), "Привет... Мир");
  });

  it("collapses em-dash sequences", () => {
    assert.strictEqual(cleanText("Привет — — — Мир"), "Привет — Мир");
  });

  it("removes hallucination: консультация...вопросы...ответы (prompt leak variant)", () => {
    const result = cleanText("Консультация, вопросы и ответы. Давайте начнём.");
    assert.ok(!result.includes("Консультация"));
    assert.ok(result.includes("Давайте начнём"));
  });

  it("removes hallucination: лайк", () => {
    const result = cleanText("Ставьте лайк! Итак, по проекту.");
    assert.ok(!result.includes("лайк"));
  });

  it("returns empty for very short fragments", () => {
    assert.strictEqual(cleanText(""), "");
    assert.strictEqual(cleanText("а"), "");
  });

  it("collapses whitespace", () => {
    assert.strictEqual(cleanText("  Привет   мир  "), "Привет мир");
  });

  it("returns empty for whitespace only", () => {
    assert.strictEqual(cleanText("   "), "");
  });
});
