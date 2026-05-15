import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Chunk, Session, Config, TranscriptEntry } from "./types.js";

export function expandPath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configPath = expandPath("~/.meet/config.json");
  let fileConfig: Partial<Config> = {};
  if (existsSync(configPath)) {
    const raw = require("node:fs").readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(raw);
  }
  return {
    modelPath: overrides?.modelPath ?? fileConfig.modelPath ?? "~/.meet/models/ggml-small.bin",
    outputDir: overrides?.outputDir ?? fileConfig.outputDir ?? "~/Meetings",
    chunkDurationSeconds: overrides?.chunkDurationSeconds ?? fileConfig.chunkDurationSeconds ?? 30,
    language: overrides?.language ?? fileConfig.language ?? "ru",
    whisperBin: overrides?.whisperBin ?? fileConfig.whisperBin ?? "whisper-cli",
    captureBin: overrides?.captureBin ?? fileConfig.captureBin ?? "",
    prompt: overrides?.prompt ?? fileConfig.prompt ?? "Транскрипция деловой встречи на русском языке.",
    opencodeBin: overrides?.opencodeBin ?? fileConfig.opencodeBin ?? "opencode",
    micVoiceProcessing: overrides?.micVoiceProcessing ?? fileConfig.micVoiceProcessing ?? false,
    silenceGate: overrides?.silenceGate ?? fileConfig.silenceGate ?? true,
    micRmsThresholdDb: overrides?.micRmsThresholdDb ?? fileConfig.micRmsThresholdDb ?? -65,
    sysRmsThresholdDb: overrides?.sysRmsThresholdDb ?? fileConfig.sysRmsThresholdDb ?? -65,
    normalizeForWhisper: overrides?.normalizeForWhisper ?? fileConfig.normalizeForWhisper ?? true,
    whisperEntropyThreshold: overrides?.whisperEntropyThreshold ?? fileConfig.whisperEntropyThreshold ?? 2.0,
    whisperLogprobThreshold: overrides?.whisperLogprobThreshold ?? fileConfig.whisperLogprobThreshold ?? -0.35,
    whisperNoSpeechThreshold: overrides?.whisperNoSpeechThreshold ?? fileConfig.whisperNoSpeechThreshold ?? 0.75,
  };
}

export async function writeAtomic(filePath: string, data: string): Promise<void> {
  const tmp = filePath + ".tmp";
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, filePath);
}

export async function readSession(sessionDir: string): Promise<Session | null> {
  const path = join(sessionDir, "session.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf-8"));
}

export async function writeSession(session: Session): Promise<void> {
  const path = join(session.sessionDir, "session.json");
  await writeAtomic(path, JSON.stringify(session, null, 2));
}

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

export function formatStartTime(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}_${h}-${min}`;
}

export function getOutputDir(config: Config, title: string, startedAt: Date): string {
  const baseDir = expandPath(config.outputDir);
  const slug = generateSlug(title);
  const ts = formatStartTime(startedAt);
  return join(baseDir, `${ts}-${slug}`);
}

export function getOutputPath(config: Config, title: string, startedAt: Date): string {
  return join(getOutputDir(config, title, startedAt), "transcript.md");
}

export function getCaptureBinPath(): string {
  const repoRoot = resolve(import.meta.dirname, "..");
  return join(repoRoot, "native", "AudioCapture", ".build", "release", "AudioCapture");
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(expandPath(path), { recursive: true });
}

export function findStaleSessions(): string[] {
  const tmpDir = "/tmp";
  try {
    const entries = require("node:fs").readdirSync(tmpDir);
    return entries
      .filter((e: string) => e.startsWith("meet-"))
      .map((e: string) => join(tmpDir, e))
      .filter((e: string) => existsSync(join(e, "session.json")));
  } catch {
    return [];
  }
}
