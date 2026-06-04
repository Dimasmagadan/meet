import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatMs,
  parseTimestampMs,
  parseWhisperJson,
  parseWhisperText,
  titleFromFilename,
  selectModel,
} from "./import.js";
import type { ImportSegment, WhisperJsonOutput } from "./import.js";
import type { Config } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

describe("formatMs", () => {
  it("formats 0 as 00:00:00", () => {
    assert.strictEqual(formatMs(0), "00:00:00");
  });

  it("formats seconds", () => {
    assert.strictEqual(formatMs(15000), "00:00:15");
  });

  it("formats minutes and seconds", () => {
    assert.strictEqual(formatMs(195000), "00:03:15");
  });

  it("formats hours", () => {
    assert.strictEqual(formatMs(3661000), "01:01:01");
  });

  it("truncates milliseconds", () => {
    assert.strictEqual(formatMs(15999), "00:00:15");
  });
});

describe("parseTimestampMs", () => {
  it("parses HH:MM:SS.mmm", () => {
    assert.strictEqual(parseTimestampMs("01:02:03.456"), 3723456);
  });

  it("parses zero timestamp", () => {
    assert.strictEqual(parseTimestampMs("00:00:00.000"), 0);
  });

  it("parses without milliseconds", () => {
    assert.strictEqual(parseTimestampMs("00:01:30.0"), 90000);
  });
});

describe("parseWhisperJson", () => {
  it("parses segments with offsets", () => {
    const data = {
      transcription: [
        { offsets: { from: 0, to: 5000 }, text: "Hello" },
        { offsets: { from: 5000, to: 10000 }, text: "World" },
      ],
    };
    const segments = parseWhisperJson(data);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[0].fromMs, 0);
    assert.strictEqual(segments[0].text, "Hello");
    assert.strictEqual(segments[1].fromMs, 5000);
    assert.strictEqual(segments[1].text, "World");
  });

  it("parses segments with timestamp strings", () => {
    const data = {
      transcription: [
        { timestamps: { from: "00:00:05.000", to: "00:00:10.000" }, text: "Five seconds in" },
      ],
    };
    const segments = parseWhisperJson(data);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].fromMs, 5000);
    assert.strictEqual(segments[0].toMs, 10000);
  });

  it("prefers offsets over timestamps", () => {
    const data = {
      transcription: [
        {
          offsets: { from: 3000, to: 8000 },
          timestamps: { from: "00:00:00.000", to: "00:00:05.000" },
          text: "Test",
        },
      ],
    };
    const segments = parseWhisperJson(data);
    assert.strictEqual(segments[0].fromMs, 3000);
    assert.strictEqual(segments[0].toMs, 8000);
  });

  it("skips empty text", () => {
    const data = {
      transcription: [
        { offsets: { from: 0, to: 5000 }, text: "" },
        { offsets: { from: 5000, to: 10000 }, text: "   " },
        { offsets: { from: 10000, to: 15000 }, text: "Keep" },
      ],
    };
    const segments = parseWhisperJson(data);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].text, "Keep");
  });

  it("handles missing transcription array", () => {
    const segments = parseWhisperJson({});
    assert.deepStrictEqual(segments, []);
  });

  it("defaults to 0 when no timestamps or offsets", () => {
    const data = {
      transcription: [{ text: "No timestamps" }],
    };
    const segments = parseWhisperJson(data);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].fromMs, 0);
    assert.strictEqual(segments[0].toMs, 0);
  });
});

describe("parseWhisperText", () => {
  it("parses timestamped lines", () => {
    const raw = "[00:00:00.000 --> 00:00:05.000]  Hello\n[00:00:05.000 --> 00:00:10.000]  World\n";
    const segments = parseWhisperText(raw);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[0].fromMs, 0);
    assert.strictEqual(segments[0].text, "Hello");
    assert.strictEqual(segments[1].fromMs, 5000);
    assert.strictEqual(segments[1].text, "World");
  });

  it("skips lines without timestamps", () => {
    const raw = "Some text without timestamps\n";
    const segments = parseWhisperText(raw);
    assert.strictEqual(segments.length, 1);
    assert.strictEqual(segments[0].fromMs, 0);
    assert.strictEqual(segments[0].toMs, 5000);
  });

  it("skips empty lines in fallback mode", () => {
    const raw = "Line one\n\nLine two\n";
    const segments = parseWhisperText(raw);
    assert.strictEqual(segments.length, 2);
    assert.strictEqual(segments[1].fromMs, 5000);
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(parseWhisperText(""), []);
  });
});

describe("titleFromFilename", () => {
  it("strips extension and capitalizes", () => {
    assert.strictEqual(titleFromFilename("my-recording.m4a"), "My Recording");
  });

  it("replaces underscores", () => {
    assert.strictEqual(titleFromFilename("weekly_standup_2026.m4a"), "Weekly Standup 2026");
  });

  it("handles full paths", () => {
    assert.strictEqual(titleFromFilename("/Users/name/Desktop/meeting recording.mp4"), "Meeting Recording");
  });

  it("handles already clean names", () => {
    assert.strictEqual(titleFromFilename("Interview.m4a"), "Interview");
  });

  it("handles multiple consecutive separators", () => {
    assert.strictEqual(titleFromFilename("my--recording.m4a"), "My Recording");
  });
});

describe("selectModel", () => {
  const baseConfig: Config = {
    ...DEFAULT_CONFIG,
    liveModelPath: "~/.meet/models/ggml-small.bin",
    finalModelPath: "~/.meet/models/ggml-medium.bin",
    modelPath: "~/.meet/models/ggml-small.bin",
  };

  it("returns live model for small preference", () => {
    const result = selectModel(baseConfig, "small");
    assert.ok(result.includes("ggml-small.bin"));
  });

  it("returns live model when liveModelPath is set and small requested", () => {
    const config = {
      ...baseConfig,
      liveModelPath: "~/.meet/models/ggml-small-q5_1.bin",
    };
    const result = selectModel(config, "small");
    assert.ok(result.includes("ggml-small-q5_1.bin"));
  });
});

describe("formatMs + parseTimestampMs roundtrip", () => {
  it("roundtrips a typical timestamp", () => {
    const original = 1_845_000;
    const formatted = formatMs(original);
    assert.strictEqual(formatted, "00:30:45");
    const parsed = parseTimestampMs(formatted + ".000");
    assert.strictEqual(parsed, original);
  });
});
