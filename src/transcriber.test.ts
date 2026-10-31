import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseChunkFilename, cleanText, buildWhisperArgs } from "./transcriber.js";
import { DEFAULT_CONFIG } from "./types.js";

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

  it("parses mic-1.wav (non-zero-padded)", () => {
    assert.deepStrictEqual(parseChunkFilename("mic-1.wav"), { source: "mic", index: 1 });
  });

  it("parses mic-1000.wav (Swift's %03d grows past 3 digits for long recordings)", () => {
    assert.deepStrictEqual(parseChunkFilename("mic-1000.wav"), { source: "mic", index: 1000 });
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

  it("removes hallucination: оставляйте комментарии", () => {
    const result = cleanText("Оставляйте комментарии! Итак, по проекту.");
    assert.ok(!result.includes("комментари"));
  });

  it("removes hallucination: оформляйте подписку", () => {
    const result = cleanText("Оформляйте подписку! Итак, по проекту.");
    assert.ok(!result.includes("подписку"));
  });

  // Preservation fixtures (High #8): бытовое/деловое употребление тех же
  // слов не должно вырезаться — раньше bare /лайк/, /комментарий/, /подписка/
  // ловили эти слова в любом контексте.
  it("preserves 'комментарий' in ordinary business text", () => {
    const text = "Добавь комментарий к задаче в трекере.";
    assert.strictEqual(cleanText(text), text);
  });

  it("preserves 'подписка' in ordinary business text", () => {
    const text = "Мы оформили подписку на сервис в прошлом месяце.";
    assert.strictEqual(cleanText(text), text);
  });

  it("preserves 'лайк' when not part of the call-to-action phrase", () => {
    const text = "Слово лайк тут используется просто как пример термина.";
    assert.strictEqual(cleanText(text), text);
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

// P2-1 canaries (SPEC_SAFETY_NET_2026-10-31 §4.1): these are real meeting
// sentences the old per-pattern drop deleted outright. If cleanText regresses,
// these fail first.
describe("cleanText dominance rule (P2-1)", () => {
  it("keeps «Просим прощения за задержку, сейчас всё настроим.» unchanged", () => {
    const text = "Просим прощения за задержку, сейчас всё настроим.";
    assert.strictEqual(cleanText(text), text);
  });

  it("keeps «Корректор проверил текст договора, всё в порядке.» unchanged", () => {
    const text = "Корректор проверил текст договора, всё в порядке.";
    assert.strictEqual(cleanText(text), text);
  });

  it("keeps «Плановые технические работы начнутся в субботу, сервис будет недоступен.» unchanged", () => {
    const text = "Плановые технические работы начнутся в субботу, сервис будет недоступен.";
    assert.strictEqual(cleanText(text), text);
  });

  it("keeps «Это была консультация, обсудили вопросы и ответы по проекту.» unchanged", () => {
    const text = "Это была консультация, обсудили вопросы и ответы по проекту.";
    assert.strictEqual(cleanText(text), text);
  });

  it("real hallucinations still die: подписывайтесь outro", () => {
    assert.strictEqual(cleanText("Подписывайтесь на наш канал!"), "");
  });

  it("real hallucinations still die: благодарим за просмотр + лайки", () => {
    assert.strictEqual(cleanText("Благодарим за просмотр, ставьте лайки"), "");
  });

  it("real hallucinations still die: смотрите ... на канале", () => {
    assert.strictEqual(cleanText("Смотрите полное видео на канале"), "");
    assert.strictEqual(cleanText("Смотрите на нашем канале"), "");
  });

  it("real hallucinations still die: [музыка]", () => {
    assert.strictEqual(cleanText("[музыка]"), "");
  });

  it("mixed sentence survives intact — dominance drops only when matches cover the sentence", () => {
    // The anchored "благодарим за просмотр" match leaves 2 content words
    // (перейдём, делу) and covers 57% of non-space chars (< 60%) — so the
    // dominance rule keeps the sentence, including the stock phrase. Pinned
    // deliberately: the alternative (stripping the matched span) would
    // silently rewrite surviving sentences.
    const text = "Благодарим за просмотр мы перейдём к делу";
    assert.strictEqual(cleanText(text), text);
  });

  it("prompt leak still dies standalone but survives mid-sentence", () => {
    assert.strictEqual(cleanText("Встреча на русском языке."), "");
    const text = "Обсудили встречу на русском языке и разошлись.";
    assert.strictEqual(cleanText(text), text);
  });

  it("a short real sentence with a stock word survives when anchored pattern does not match", () => {
    // Bare /просим прощения/ used to kill this; the anchored form + dominance
    // keep it.
    const text = "Коллеги, технические работы завершились.";
    assert.strictEqual(cleanText(text), text);
  });
});

describe("buildWhisperArgs", () => {
  // Point vocab at a non-existent path so the prompt suffix is deterministic
  // (the repo-root vocabulary.json is empty today, but these tests must not
  // depend on that).
  const baseConfig = { ...DEFAULT_CONFIG, vocabularyPath: "/nonexistent-vocab-test.json" };

  it("builds the live invocation (txt, noTimestamps, live thresholds)", () => {
    const args = buildWhisperArgs(baseConfig, {
      modelPath: "/m/small.bin",
      inputPath: "/s/mic-001.wav",
      outputBase: "/s/out",
      format: "txt",
      pass: "live",
      noTimestamps: true,
    });
    assert.deepStrictEqual(args, [
      "-m", "/m/small.bin",
      "-l", "ru",
      "-f", "/s/mic-001.wav",
      "-otxt",
      "-of", "/s/out",
      "--suppress-nst",
      "-sow",
      "--max-len", "300",
      "--entropy-thold", "2.4",
      "--logprob-thold", "-1",
      "--no-speech-thold", "0.6",
      "--no-prints",
      "--prompt", DEFAULT_CONFIG.prompt,
      "--no-timestamps",
    ]);
  });

  it("builds the final invocation (json, final thresholds, beam-search)", () => {
    const args = buildWhisperArgs(baseConfig, {
      modelPath: "/m/medium.bin",
      inputPath: "/s/sys-001.wav",
      outputBase: "/s/out",
      format: "json",
      pass: "final",
    });
    assert.deepStrictEqual(args, [
      "-m", "/m/medium.bin",
      "-l", "ru",
      "-f", "/s/sys-001.wav",
      "-oj",
      "-of", "/s/out",
      "--suppress-nst",
      "-sow",
      "--max-len", "300",
      "--entropy-thold", "1.5",
      "--logprob-thold", "-1.5",
      "--no-speech-thold", "0.7",
      "--no-prints",
      "--prompt", DEFAULT_CONFIG.prompt,
      "--beam-size", "5",
      "--best-of", "3",
    ]);
  });

  it("omits --no-timestamps when not requested", () => {
    const args = buildWhisperArgs(baseConfig, {
      modelPath: "/m/small.bin",
      inputPath: "/s/mic-001.wav",
      outputBase: "/s/out",
      format: "txt",
      pass: "live",
    });
    assert.ok(!args.includes("--no-timestamps"));
  });

  it("omits beam-search flags when finalBeamSize/finalBestOf are 0", () => {
    const cfg = { ...baseConfig, finalBeamSize: 0, finalBestOf: 0 };
    const args = buildWhisperArgs(cfg, {
      modelPath: "/m/medium.bin",
      inputPath: "/s/sys-001.wav",
      outputBase: "/s/out",
      format: "json",
      pass: "final",
    });
    assert.ok(!args.includes("--beam-size"));
    assert.ok(!args.includes("--best-of"));
  });

  it("appends the vocabulary suffix to --prompt when terms exist", () => {
    const vocabPath = resolve(tmpdir(), `meet-vocab-${process.pid}-${Date.now()}.json`);
    writeFileSync(vocabPath, JSON.stringify({ terms: ["alpha", "beta"] }));
    try {
      // Unique path bypasses the module-level vocab cache (keyed by path).
      const cfg = { ...baseConfig, vocabularyPath: vocabPath };
      const args = buildWhisperArgs(cfg, {
        modelPath: "/m/small.bin",
        inputPath: "/s/mic-001.wav",
        outputBase: "/s/out",
        format: "txt",
        pass: "live",
        noTimestamps: true,
      });
      const prompt = args[args.indexOf("--prompt") + 1];
      assert.ok(prompt.startsWith(DEFAULT_CONFIG.prompt), `got: ${prompt}`);
      assert.ok(prompt.includes(". Термины: alpha, beta"), `got: ${prompt}`);
    } finally {
      rmSync(vocabPath, { force: true });
    }
  });
});
