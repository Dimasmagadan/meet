import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import chalk from "chalk";
import { AttentionMonitor, buildRecap, formatRecap, buildNotificationArgs, type AttentionAlert } from "./attention.js";
import { DEFAULT_CONFIG, type Config, type TranscriptEntry } from "./types.js";

// Force chalk to emit ANSI under the non-TTY test runner so highlight assertions can match exact sequences.
chalk.level = 1;

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
    assert.strictEqual(monitor.check(5, "Слушай, Дим, ты тут?", () => []), null);
  });

  it("returns null when text has no trigger match", () => {
    const config = makeConfig({}, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    assert.strictEqual(monitor.check(5, "Ничего интересного тут нет", () => []), null);
  });

  it("returns an alert on match", () => {
    const config = makeConfig({}, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    const alert = monitor.check(5, "Слушай, Дим, ты тут?", () => []);
    assert.ok(alert);
    assert.strictEqual(alert!.kind, "trigger");
    assert.strictEqual(alert!.trigger, "Дим");
    assert.strictEqual(alert!.chunkIndex, 5);
  });

  it("suppresses a second alert within the cooldown window", () => {
    const config = makeConfig({ attentionCooldownSeconds: 60 }, triggersPath);
    let now = 0;
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => now });
    assert.ok(monitor.check(5, "Дим, ты тут?", () => []));
    now = 30_000; // 30s later, within 60s cooldown
    assert.strictEqual(monitor.check(6, "Дим, ты слышишь?", () => []), null);
  });

  it("allows a new alert once the cooldown has elapsed", () => {
    const config = makeConfig({ attentionCooldownSeconds: 60 }, triggersPath);
    let now = 0;
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => now });
    assert.ok(monitor.check(5, "Дим, ты тут?", () => []));
    now = 61_000; // past 60s cooldown
    assert.ok(monitor.check(6, "Дим, ты слышишь?", () => []));
  });

  it("passes recapEntries from config through to the alert", () => {
    const config = makeConfig({ attentionRecapEntries: 3 }, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    const alert = monitor.check(5, "Дим, ты тут?", () => []);
    assert.strictEqual(alert!.recapEntries, 3);
  });

  it("suppresses the alert when the recap window contains a mic entry", () => {
    const config = makeConfig({ attentionRecapEntries: 3 }, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    const entries: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 3, timestamp: "10:00:30", text: "раньше" },
      { source: "mic", chunkIndex: 4, timestamp: "10:00:45", text: "я говорил" },
      { source: "sys", chunkIndex: 5, timestamp: "10:01:00", text: "Дим, ты тут?" },
    ];
    assert.strictEqual(monitor.check(5, "Дим, ты тут?", () => entries), null);
  });

  it("fires the alert when the recap window contains only sys entries", () => {
    const config = makeConfig({ attentionRecapEntries: 3 }, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    const entries: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 3, timestamp: "10:00:30", text: "раньше" },
      { source: "sys", chunkIndex: 4, timestamp: "10:00:45", text: "ещё раньше" },
      { source: "sys", chunkIndex: 5, timestamp: "10:01:00", text: "Дим, ты тут?" },
    ];
    assert.ok(monitor.check(5, "Дим, ты тут?", () => entries));
  });

  it("does not apply suppression when the mic entry is outside the recap window", () => {
    const config = makeConfig({ attentionRecapEntries: 3 }, triggersPath);
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => 0 });
    const entries: TranscriptEntry[] = [
      { source: "mic", chunkIndex: 1, timestamp: "10:00:00", text: "давно" },
      { source: "sys", chunkIndex: 3, timestamp: "10:00:30", text: "раньше" },
      { source: "sys", chunkIndex: 4, timestamp: "10:00:45", text: "ещё" },
      { source: "sys", chunkIndex: 5, timestamp: "10:01:00", text: "Дим, ты тут?" },
    ];
    assert.ok(monitor.check(5, "Дим, ты тут?", () => entries));
  });

  it("does not consume cooldown when suppressed — next eligible trigger fires immediately", () => {
    const config = makeConfig({ attentionCooldownSeconds: 60, attentionRecapEntries: 3 }, triggersPath);
    let now = 0;
    const monitor = new AttentionMonitor(SESSION, { loadConfig: () => config, now: () => now });
    const withMic: TranscriptEntry[] = [
      { source: "mic", chunkIndex: 4, timestamp: "10:00:45", text: "я говорил" },
      { source: "sys", chunkIndex: 5, timestamp: "10:01:00", text: "Дим, ты тут?" },
    ];
    assert.strictEqual(monitor.check(5, "Дим, ты тут?", () => withMic), null);
    now = 1_000; // 1s later — would normally be inside cooldown if it had been consumed
    const onlySys: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 5, timestamp: "10:01:00", text: "Дим, ты тут?" },
      { source: "sys", chunkIndex: 6, timestamp: "10:01:15", text: "Дим, ты слышишь?" },
    ];
    assert.ok(monitor.check(6, "Дим, ты слышишь?", () => onlySys));
  });
});

describe("buildRecap", () => {
  const entries: TranscriptEntry[] = [
    { source: "mic", chunkIndex: 1, timestamp: "10:00:00", text: "старый" },
    { source: "sys", chunkIndex: 4, timestamp: "10:00:45", text: "тоже старый" },
    { source: "mic", chunkIndex: 8, timestamp: "10:01:45", text: "в окне" },
    { source: "sys", chunkIndex: 10, timestamp: "10:02:15", text: "триггерный чанк" },
  ];

  it("returns the last N entries ending at the alert chunk", () => {
    const recap = buildRecap(entries, 10, 3);
    assert.deepStrictEqual(
      recap.map((e) => e.chunkIndex),
      [4, 8, 10],
    );
  });

  it("excludes entries with chunkIndex greater than the alert chunk", () => {
    const withFuture: TranscriptEntry[] = [
      ...entries,
      { source: "sys", chunkIndex: 12, timestamp: "10:02:45", text: "будущее" },
    ];
    const recap = buildRecap(withFuture, 10, 3);
    assert.deepStrictEqual(
      recap.map((e) => e.chunkIndex),
      [4, 8, 10],
    );
  });

  it("returns all available entries when fewer than count", () => {
    const recap = buildRecap(entries, 10, 100);
    assert.deepStrictEqual(recap, entries);
  });

  it("returns an empty array when count is 0 (guards against slice(-0) returning everything)", () => {
    const recap = buildRecap(entries, 10, 0);
    assert.deepStrictEqual(recap, []);
  });
});

describe("formatRecap", () => {
  const alert: AttentionAlert = {
    kind: "trigger",
    trigger: "Дим",
    snippet: "…слушай, Дим, что думаешь…",
    timestamp: "10:02:15",
    chunkIndex: 10,
    recapEntries: 5,
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

  it("wraps every occurrence of the trigger word in the yellow-bold escape sequence", () => {
    const plain = formatRecap(alert, entries);
    const expected = chalk.yellow.bold("Дим");
    const count = plain.split(expected).length - 1;
    // entries contain "Дим" exactly once (in the sys line)
    assert.strictEqual(count, 1);
  });

  it("highlights all occurrences across recap entries, not just the matching line", () => {
    const multi: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 9, timestamp: "10:02:00", text: "Дим, иди сюда" },
      { source: "sys", chunkIndex: 10, timestamp: "10:02:15", text: "слушай, Дим, что думаешь" },
    ];
    const plain = formatRecap(alert, multi);
    const expected = chalk.yellow.bold("Дим");
    const count = plain.split(expected).length - 1;
    assert.strictEqual(count, 2);
  });

  it("preserves surrounding text around the highlighted trigger", () => {
    const plain = formatRecap(alert, entries);
    // Strip all ANSI codes and verify the original line text is intact
    const stripped = plain.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(stripped.includes("слушай, Дим, что думаешь"));
  });

  it("does not truncate long entry text", () => {
    const longText = "а".repeat(500);
    const longEntries: TranscriptEntry[] = [
      { source: "sys", chunkIndex: 10, timestamp: "10:02:15", text: longText },
    ];
    const plain = formatRecap(alert, longEntries);
    const stripped = plain.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(stripped.includes(longText));
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
      recapEntries: 1,
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
      recapEntries: 1,
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
      recapEntries: 1,
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
      recapEntries: 1,
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
      recapEntries: 1,
    };
    const args = buildNotificationArgs(alert, "Ping");
    assert.strictEqual(args[7], "meet — attention");
    assert.strictEqual(args[8], "Ping");
  });
});
