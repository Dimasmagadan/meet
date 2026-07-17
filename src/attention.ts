import { execFile } from "node:child_process";
import chalk from "chalk";
import type { Config, TranscriptEntry } from "./types.js";
import { loadConfig } from "./storage.js";
import { getTriggers } from "./triggers.js";
import { chunkToTimestamp } from "./assembler.js";

export type AttentionAlertKind = "trigger";

export type AttentionAlert = {
  kind: AttentionAlertKind; // future: | "pause"
  trigger: string;
  snippet: string;
  timestamp: string;
  chunkIndex: number;
  windowChunks: number;
};

export interface AttentionSession {
  chunkDurationSeconds: number;
  startedAt: string;
}

export interface AttentionMonitorDeps {
  now?: () => number;
  loadConfig?: () => Config;
}

const BANNER_WIDTH = 58;
const NOTIFICATION_MAX_LEN = 150;

export class AttentionMonitor {
  private session: AttentionSession;
  private now: () => number;
  private loadConfig: () => Config;
  private lastAlertAt = new Map<AttentionAlertKind, number>();

  constructor(session: AttentionSession, deps?: AttentionMonitorDeps) {
    this.session = session;
    this.now = deps?.now ?? Date.now;
    this.loadConfig = deps?.loadConfig ?? loadConfig;
  }

  check(chunkIndex: number, text: string): AttentionAlert | null {
    const config = this.loadConfig();
    if (!config.attentionAlerts) return null;

    const triggers = getTriggers(config);
    const match = triggers.match(text);
    if (!match) return null;

    const kind: AttentionAlertKind = "trigger";
    const nowMs = this.now();
    const last = this.lastAlertAt.get(kind);
    if (last !== undefined && nowMs - last < config.attentionCooldownSeconds * 1000) {
      return null;
    }
    this.lastAlertAt.set(kind, nowMs);

    return {
      kind,
      trigger: match.trigger,
      snippet: match.snippet,
      timestamp: chunkToTimestamp(chunkIndex, this.session.chunkDurationSeconds, this.session.startedAt),
      chunkIndex,
      windowChunks: Math.ceil(config.attentionRecapSeconds / this.session.chunkDurationSeconds),
    };
  }
}

export function buildRecap(entries: TranscriptEntry[], alertChunkIndex: number, windowChunks: number): TranscriptEntry[] {
  const minChunkIndex = alertChunkIndex - windowChunks;
  return entries.filter((entry) => entry.chunkIndex >= minChunkIndex);
}

export function formatRecap(alert: AttentionAlert, entries: TranscriptEntry[]): string {
  const lines: string[] = [];
  const rule = "═".repeat(BANNER_WIDTH);

  lines.push(chalk.yellow(rule));
  lines.push(chalk.yellow.bold(`  ⚡ ATTENTION [${alert.timestamp}] — trigger «${alert.trigger}» matched`));
  lines.push(chalk.yellow(`  "${alert.snippet}"`));
  lines.push(chalk.gray("─".repeat(BANNER_WIDTH)));

  for (const entry of entries) {
    const label = entry.source === "mic" ? "Me" : (entry.speaker ?? "Others");
    const line = `  [${entry.timestamp}] ${label}: ${entry.text}`;
    const isMatch = entry.source === "sys" && entry.chunkIndex === alert.chunkIndex;
    lines.push(isMatch ? chalk.yellow.bold(line) : chalk.gray(line));
  }

  lines.push(chalk.yellow(`${rule} end recap`));
  return lines.join("\n") + "\n";
}

export function buildNotificationArgs(alert: AttentionAlert, sound: string): string[] {
  const raw = `«${alert.trigger}» — "${alert.snippet}"`;
  const message = truncate(stripControlChars(raw), NOTIFICATION_MAX_LEN);

  return [
    "-e", "on run argv",
    "-e", "display notification (item 1 of argv) with title (item 2 of argv) sound name (item 3 of argv)",
    "-e", "end run",
    message,
    "meet — attention",
    sound,
  ];
}

export function sendMacNotification(alert: AttentionAlert, sound = "Glass"): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("osascript", buildNotificationArgs(alert, sound), { timeout: 10_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x1F\x7F]/g, " ");
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + "…";
}
