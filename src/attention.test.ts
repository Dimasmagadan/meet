import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttentionMonitor, buildRecap, formatRecap, buildNotificationArgs, type AttentionAlert } from "./attention.js";
import { DEFAULT_CONFIG, type Config, type TranscriptEntry } from "./types.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `meet-test-attention-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTriggers(path: string, triggers: string[]) {
  writeFileSync(path, JSON.stringify({ triggers }), "utf-8");
}

function makeConfig(overrides: Partial<Config>, triggersPath: string): Config {
  return {
    ...DEFAULT_CONFIG,
    triggersPath,
    triggersReload: false,
    ...overrides,
  };
}

const SESSION = { chunkDurationSeconds: 15, startedAt: "2026-07-17T10:00:00.000Z" };

describe("AttentionMonitor.check", () => {
  let tmpDir: string;
  let triggersPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    triggersPath = join(tmpDir, "triggers.json");
    writeTriggers(triggersPath, ["Дим"]);
  });

  it("returns null when attentionAlerts disabled", () => {
    const config = makeConfig({ attentionAlerts: false }, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    assert.strictEqual(monitor.check(5, "Слушай, Дим, ты тут?"), null);
  });

  it("returns null when text has no trigger match", () => {
    const config = makeConfig({}, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    assert.strictEqual(monitor.check(5, "Ничего интересного тут нет"), null);
  });

  it("returns an alert on match", () => {
    const config = makeConfig({}, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    const alert = monitor.check(5, "Слушай, Дим, ты тут?");
    assert.ok(alert);
    assert.strictEqual(alert!.kind, "trigger");
    assert.strictEqual(alert!.trigger, "Дим");
    assert.strictEqual(alert!.chunkIndex, 5);
  });

  it("suppresses a second alert within the cooldown window", () => {
    const config = makeConfig({ attentionCooldownSeconds: 60 }, triggersPath);
    let now = 0;
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => now });
    assert.ok(monitor.check(5, "Дим, ты тут?"));
    now = 30_000; // 30s later, within 60s cooldown
    assert.strictEqual(monitor.check(6, "Дим, ты слышишь?"), null);
  });

  it("allows a new alert once the cooldown has elapsed", () => {
    const config = makeConfig({ attentionCooldownSeconds: 60 }, triggersPath);
    let now = 0;
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => now });
    assert.ok(monitor.check(5, "Дим, ты тут?"));
    now = 61_000; // past 60s cooldown
    assert.ok(monitor.check(6, "Дим, ты слышишь?"));
  });

  it("computes windowChunks from attentionRecapSeconds / chunkDurationSeconds", () => {
    const config = makeConfig({ attentionRecapSeconds: 180 }, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    const alert = monitor.check(5, "Дим, ты тут?");
    assert.strictEqual(alert!.windowChunks, 12); // 180 / 15
  });
});

describe("buildRecap", () => {
  const entries: TranscriptEntry[] = [
    { source: "mic", chunkIndex: 1, timestamp: "10:00:00", text: "старый" },
    { source: "sys", chunkIndex: 4, timestamp: "10:00:45", text: "тоже старый" },
    { source: "mic", chunkIndex: 8, timestamp: "10:01:45", text: "в окне" },
    { source: "sys", chunkIndex: 10, timestamp: "10:02:15", text: "триггерный чанк" },
  ];

  it("filters to the window and includes the triggering chunk", () => {
    const recap = buildRecap(entries, 10, 5); // window: chunkIndex >= 5
    assert.deepStrictEqual(
      recap.map((e) => e.chunkIndex),
      [8, 10],
    );
  });

  it("preserves the merged mic+sys order of the input", () => {
    const recap = buildRecap(entries, 10, 100);
    assert.deepStrictEqual(recap, entries);
  });
});

describe("formatRecap", () => {
  const alert: AttentionAlert = {
    kind: "trigger",
    trigger: "Дим",
    snippet: "…слушай, Дим, что думаешь…",
    timestamp: "10:02:15",
    chunkIndex: 10,
    windowChunks: 5,
  };

  const entries: TranscriptEntry[] = [
    { source: "mic", chunkIndex: 8, timestamp: "10:01:45", text: "в окне" },
    { source: "sys", chunkIndex: 10, timestamp: "10:02:15", text: "слушай, Дим, что думаешь" },
  ];

  it("includes banner delimiters, trigger name, and matched line", () => {
    const banner = formatRecap(alert, entries);
    assert.ok(banner.includes("═"));
    assert.ok(banner.includes("─"));
    assert.ok(banner.includes("ATTENTION"));
    assert.ok(banner.includes("Дим"));
    assert.ok(banner.includes("end recap"));
  });

  it("labels mic entries as Me and sys entries as Others", () => {
    const banner = formatRecap(alert, entries);
    assert.ok(banner.includes("Me:"));
    assert.ok(banner.includes("Others:"));
  });

  it("uses the speaker label when present instead of Others", () => {
    const withSpeaker: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 10, timestamp: "10:02:15", text: "слушай, Дим", speaker: "Speaker 1" },
    ];
    const banner = formatRecap(alert, withSpeaker);
    assert.ok(banner.includes("Speaker 1:"));
    assert.strictEqual(banner.includes("Others:"), false);
  });
});

describe("buildNotificationArgs", () => {
  it("uses the argv form and never interpolates text into -e source", () => {
    const alert: AttentionAlert = {
      kind: "trigger",
      trigger: "Дим",
      snippet: "test",
      timestamp: "10:00:00",
      chunkIndex: 1,
      windowChunks: 1,
    };
    const args = buildNotificationArgs(alert, "Glass");
    assert.deepStrictEqual(args.slice(0, 6), [
      "-e", "on run argv",
      "-e", "display notification (item 1 of argv) with title (item 2 of argv) sound name (item 3 of argv)",
      "-e", "end run",
    ]);
  });

  it("passes quotes and backslashes in the message intact, unescaped", () => {
    const alert: AttentionAlert = {
      kind: "trigger",
      trigger: 'Дим "the guy" \\ escaped',
      snippet: "test",
      timestamp: "10:00:00",
      chunkIndex: 1,
      windowChunks: 1,
    };
    const args = buildNotificationArgs(alert, "Glass");
    const message = args[6];
    assert.ok(message.includes('"the guy"'));
    assert.ok(message.includes("\\"));
  });

  it("strips control characters like newlines from the message", () => {
    const alert: AttentionAlert = {
      kind: "trigger",
      trigger: "Дим",
      snippet: "line one\nline two\ttabbed",
      timestamp: "10:00:00",
      chunkIndex: 1,
      windowChunks: 1,
    };
    const args = buildNotificationArgs(alert, "Glass");
    const message = args[6];
    assert.strictEqual(message.includes("\n"), false);
    assert.strictEqual(message.includes("\t"), false);
  });

  it("truncates long messages to ~150 chars", () => {
    const alert: AttentionAlert = {
      kind: "trigger",
      trigger: "Дим",
      snippet: "a".repeat(300),
      timestamp: "10:00:00",
      chunkIndex: 1,
      windowChunks: 1,
    };
    const args = buildNotificationArgs(alert, "Glass");
    const message = args[6];
    assert.ok(message.length <= 150);
    assert.ok(message.endsWith("…"));
  });

  it("passes title and sound as separate argv items", () => {
    const alert: AttentionAlert = {
      kind: "trigger",
      trigger: "Дим",
      snippet: "test",
      timestamp: "10:00:00",
      chunkIndex: 1,
      windowChunks: 1,
    };
    const args = buildNotificationArgs(alert, "Ping");
    assert.strictEqual(args[7], "meet — attention");
    assert.strictEqual(args[8], "Ping");
  });
});
