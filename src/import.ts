import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { tmpdir } from "node:os";
import chalk from "chalk";
import { nanoid } from "nanoid";
import type { Session, Config, TranscriptEntry } from "./types.js";
import { loadConfig, expandPath, getOutputDir, getOutputPath } from "./storage.js";
import { cleanText } from "./transcriber.js";
import { getPhrasebook } from "./phrasebook.js";
import { assembleMarkdown } from "./assembler.js";
import { runTagPicker, writeMetaFile } from "./tags.js";
import { runOpencodeIndex } from "./opencode.js";

export interface ImportOptions {
  title?: string;
  model?: "small" | "medium";
  noIndex?: boolean;
  date?: string;
}

export interface ImportSegment {
  fromMs: number;
  toMs: number;
  text: string;
}

interface BatchResult {
  file: string;
  success: boolean;
  outputPath?: string;
  error?: string;
}

export async function transcribeImport(
  filePaths: string[],
  options: ImportOptions,
): Promise<void> {
  const resolved = filePaths.map((f) => resolve(f));

  for (const fp of resolved) {
    if (!existsSync(fp)) {
      console.log(chalk.red(`File not found: ${fp}`));
      process.exit(1);
    }
  }

  if (!checkFfmpeg()) {
    console.log(chalk.red("ffmpeg not found. Install: brew install ffmpeg"));
    process.exit(1);
  }

  const config = loadConfig();
  const modelPath = selectModel(config, options.model);
  if (!existsSync(modelPath)) {
    console.log(chalk.red(`Model not found: ${modelPath}`));
    console.log(chalk.gray("Run: meet setup"));
    process.exit(1);
  }

  const whisperPath = findWhisper();
  if (!whisperPath) {
    console.log(chalk.red("whisper-cli not found. Install: brew install whisper-cpp"));
    process.exit(1);
  }

  const total = resolved.length;
  const results: BatchResult[] = [];

  for (let i = 0; i < resolved.length; i++) {
    const fp = resolved[i];
    const prefix = total > 1 ? `[${i + 1}/${total}] ` : "";

    const title = options.title && total === 1
      ? options.title
      : titleFromFilename(fp);

    console.log(chalk.cyan(`${prefix}${basename(fp)}`));

    try {
      const outputPath = await processFile(fp, title, config, modelPath, whisperPath, options, prefix);
      results.push({ file: fp, success: true, outputPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`${prefix}Failed: ${msg}`));
      results.push({ file: fp, success: false, error: msg });
    }
  }

  if (total > 1) {
    const ok = results.filter((r) => r.success).length;
    const fail = results.filter((r) => !r.success).length;
    console.log();
    console.log(chalk.green(`Done: ${ok}/${total} transcribed`));
    if (fail > 0) {
      console.log(chalk.yellow(`${fail} failed`));
    }
  }
}

async function processFile(
  filePath: string,
  title: string,
  config: Config,
  modelPath: string,
  whisperPath: string,
  options: ImportOptions,
  prefix: string,
): Promise<string> {
  const id = nanoid(8);
  const sessionDir = join(tmpdir(), `meet-import-${id}`);
  await mkdir(sessionDir, { recursive: true });

  try {
    let date: Date;
    if (options.date) {
      date = new Date(options.date + "T12:00:00");
      if (isNaN(date.getTime())) {
        throw new Error(`Invalid date: ${options.date}`);
      }
    } else {
      const info = await stat(filePath);
      date = info.mtime;
    }

    const meetingDir = getOutputDir(config, title, date);
    const outputFile = getOutputPath(config, title, date);
    await mkdir(meetingDir, { recursive: true });

    console.log(chalk.gray(`${prefix}Converting to WAV...`));
    const wavPath = join(sessionDir, "full.wav");
    await convertToWav(filePath, wavPath);

    console.log(chalk.gray(`${prefix}Transcribing (${basename(modelPath).replace("ggml-", "").replace(".bin", "")})...`));
    const rawSegments = await runWhisper(wavPath, config, modelPath, whisperPath, sessionDir);

    const pb = getPhrasebook(config);
    let segments = collapseRepetitions(rawSegments);
    segments = mergeShortSegments(segments, 15000);

    const entries: TranscriptEntry[] = [];
    for (const seg of segments) {
      const cleaned = cleanText(seg.text);
      if (!cleaned) continue;
      const text = pb.apply(cleaned);
      if (!text) continue;
      entries.push({
        source: "file",
        chunkIndex: 0,
        timestamp: formatMs(seg.fromMs),
        text,
      });
    }

    if (entries.length === 0) {
      console.log(chalk.yellow(`${prefix}No speech detected`));
      return "";
    }

    const markdown = assembleMarkdown(title, date.toISOString(), entries);
    await writeFile(outputFile, markdown, "utf-8");
    console.log(chalk.green(`${prefix}Transcript: ${outputFile}`));
    console.log(chalk.gray(`${prefix}${entries.length} segments`));

    const session: Session = {
      id,
      title,
      mode: "full",
      startedAt: date.toISOString(),
      chunkDurationSeconds: 15,
      sessionDir,
      outputFile,
      capturePid: null,
      status: "done",
      processedChunks: [],
      lastError: null,
      autoStopReason: null,
      latestProcessedOffsetSeconds: 0,
      lastMeaningfulTextAtOffsetSeconds: null,
      hasMeaningfulText: true,
      tags: [],
    };

    if (process.stdin.isTTY) {
      try {
        const tags = await runTagPicker(session);
        if (tags.length > 0) {
          session.tags = tags;
          await writeMetaFile(session, tags);
          console.log(chalk.green(`${prefix}Tags: ${tags.join(", ")}`));
        }
      } catch {
        console.log(chalk.gray(`${prefix}(tag picker skipped)`));
      }
    }

    if (!options.noIndex && entries.length > 0) {
      try {
        console.log(chalk.cyan(`${prefix}Creating index.md...`));
        const indexMarkdown = await runOpencodeIndex(config, outputFile, title);
        const indexPath = join(meetingDir, "index.md");
        await writeFile(indexPath, indexMarkdown, "utf-8");
        console.log(chalk.green(`${prefix}Index: ${indexPath}`));
      } catch (err) {
        console.log(chalk.red(`${prefix}Index failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    return outputFile;
  } finally {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-i", inputPath,
        "-ar", "16000",
        "-ac", "1",
        "-sample_fmt", "s16",
        outputPath,
      ],
      { timeout: 300_000, maxBuffer: 1024 * 1024 },
      (err) => {
        if (err) {
          reject(new Error(`ffmpeg failed: ${err.message}`));
          return;
        }
        if (!existsSync(outputPath)) {
          reject(new Error("ffmpeg produced no output — unsupported format?"));
          return;
        }
        resolve();
      },
    );
  });
}

export interface WhisperJsonOutput {
  transcription?: Array<{
    timestamps?: { from?: string; to?: string };
    offsets?: { from?: number; to?: number };
    text?: string;
  }>;
}

async function runWhisper(
  wavPath: string,
  config: Config,
  modelPath: string,
  whisperPath: string,
  sessionDir: string,
): Promise<ImportSegment[]> {
  const outputBase = join(sessionDir, "result");

  const args = [
    "-m", modelPath,
    "-l", config.language,
    "-f", wavPath,
    "-oj",
    "-of", outputBase,
    "--suppress-nst",
    "-sow",
    "--max-len", "300",
    "--entropy-thold", String(config.whisperEntropyThreshold),
    "--logprob-thold", String(config.whisperLogprobThreshold),
    "--no-speech-thold", String(config.whisperNoSpeechThreshold),
    "--no-prints",
    "--prompt", config.prompt,
  ];

  return new Promise((resolve, reject) => {
    execFile(whisperPath, args, { timeout: 1_800_000, maxBuffer: 10 * 1024 * 1024 }, async (err) => {
      if (err) {
        reject(new Error(`whisper-cli failed: ${err.message}`));
        return;
      }

      const jsonPath = outputBase + ".json";
      try {
        const raw = await readFile(jsonPath, "utf-8");
        const data: WhisperJsonOutput = JSON.parse(raw);
        resolve(parseWhisperJson(data));
      } catch {
        const txtPath = outputBase + ".txt";
        try {
          const raw = await readFile(txtPath, "utf-8");
          resolve(parseWhisperText(raw));
        } catch {
          resolve([]);
        }
      }
    });
  });
}

export function parseWhisperJson(data: WhisperJsonOutput): ImportSegment[] {
  const segments: ImportSegment[] = [];
  const transcription = data.transcription || [];

  for (const seg of transcription) {
    const text = (seg.text || "").trim();
    if (!text) continue;

    let fromMs = 0;
    if (seg.offsets?.from !== undefined) {
      fromMs = seg.offsets.from;
    } else if (seg.timestamps?.from) {
      fromMs = parseTimestampMs(seg.timestamps.from);
    }

    let toMs = fromMs;
    if (seg.offsets?.to !== undefined) {
      toMs = seg.offsets.to;
    } else if (seg.timestamps?.to) {
      toMs = parseTimestampMs(seg.timestamps.to);
    }

    segments.push({ fromMs, toMs, text });
  }

  return segments;
}

export function parseWhisperText(raw: string): ImportSegment[] {
  const segments: ImportSegment[] = [];
  const lineRegex = /\[(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(.+)/;

  for (const line of raw.split("\n")) {
    const m = lineRegex.exec(line.trim());
    if (!m) continue;
    const fromMs = parseTimestampMs(m[1]);
    const toMs = parseTimestampMs(m[2]);
    const text = m[3].trim();
    if (text) segments.push({ fromMs, toMs, text });
  }

  if (segments.length > 0) return segments;

  let offsetMs = 0;
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    segments.push({ fromMs: offsetMs, toMs: offsetMs + 5000, text });
    offsetMs += 5000;
  }
  return segments;
}

export function parseTimestampMs(ts: string): number {
  const parts = ts.split(":");
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const secParts = parts[2].split(".");
  const s = parseInt(secParts[0], 10);
  const ms = secParts[1] ? parseInt(secParts[1], 10) : 0;
  return h * 3600000 + m * 60000 + s * 1000 + ms;
}

export function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function collapseRepetitions(segments: ImportSegment[]): ImportSegment[] {
  if (segments.length <= 2) return segments;

  const result: ImportSegment[] = [];
  let repeatCount = 0;
  let lastNormalized = "";

  for (const seg of segments) {
    const normalized = seg.text.trim().toLowerCase().replace(/\s+/g, " ");

    if (normalized === lastNormalized && normalized.length > 0) {
      repeatCount++;
      if (repeatCount <= 2) {
        result.push(seg);
      }
      continue;
    }

    if (repeatCount > 2 && result.length > 0) {
      const last = result[result.length - 1];
      last.text = last.text.replace(/\s*$/, "") + ` [×${repeatCount + 1}]`;
    }

    repeatCount = 0;
    lastNormalized = normalized;
    result.push(seg);
  }

  if (repeatCount > 2 && result.length > 0) {
    const last = result[result.length - 1];
    last.text = last.text.replace(/\s*$/, "") + ` [×${repeatCount + 1}]`;
  }

  return result;
}

function mergeShortSegments(segments: ImportSegment[], gapThresholdMs: number = 15000): ImportSegment[] {
  if (segments.length <= 1) return segments;

  const result: ImportSegment[] = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1];
    const curr = segments[i];
    const gap = curr.fromMs - prev.toMs;

    const prevLen = prev.text.split(/\s+/).length;
    const currLen = curr.text.split(/\s+/).length;

    if (gap < gapThresholdMs && (prevLen < 30 || currLen < 15)) {
      prev.text = prev.text.replace(/\s*$/, "") + " " + curr.text;
      prev.toMs = Math.max(prev.toMs, curr.toMs);
    } else {
      result.push({ ...curr });
    }
  }

  return result;
}

export function titleFromFilename(filePath: string): string {
  const name = basename(filePath, extname(filePath));
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function selectModel(config: Config, preference?: "small" | "medium"): string {
  if (preference === "small") {
    return expandPath(config.liveModelPath || config.modelPath);
  }

  if (config.importModelPath) {
    const p = expandPath(config.importModelPath);
    if (existsSync(p)) return p;
  }

  const mediumPath = expandPath(config.finalModelPath || config.modelPath);
  if (existsSync(mediumPath)) return mediumPath;

  return expandPath(config.liveModelPath || config.modelPath);
}

function findWhisper(): string | null {
  const paths = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
  return paths.find((p) => existsSync(p)) ?? null;
}

function checkFfmpeg(): boolean {
  const paths = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
  return paths.some((p) => existsSync(p));
}
