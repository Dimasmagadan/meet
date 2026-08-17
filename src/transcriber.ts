import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import type { Config, TranscribeOptions, AudioMetrics } from "./types.js";
import { readPcmSamples, computeRmsDb, computePeakDb } from "./audio-metrics.js";
import { detectSpeech } from "./vad.js";
import { getPhrasebook } from "./phrasebook.js";
import { getVocabulary } from "./vocabulary.js";
import { resolveWhisperBin, resolveModelPath } from "./storage.js";
import { applyQoS } from "./process-priority.js";
import { MIC_OR_SYS_CHUNK_RE } from "./regex-utils.js";

export interface TranscribeResult {
  chunkIndex: number;
  source: "mic" | "sys";
  text: string;
  metrics?: AudioMetrics;
}

const HALLUCINATION_PATTERNS: RegExp[] = [
  /редактор\s+субтитров/i,
  /корректор/i,
  /субтитры?\s+(выполнил|делал|сделал|сделала)/i,
  /технические\s+работы/i,
  /просим\s+прощения/i,
  /канал\s+обновлен/i,
  /подписывайтесь/i,
  /спасибо\s+за\s+просмотр/i,
  /приятного\s+просмотра/i,
  /оставайтесь\s+с\s+нами/i,
  /встреча\s+на\s+русском\s+языке/i,
  /консультация.*вопросы.*ответы/i,
  /обсуждение.*вопросы.*ответы/i,
  // Bare /лайк/, /комментарий/, /подписка/ used to match those words in any
  // context — including legitimate business text ("добавь комментарий к
  // задаче", "оформили подписку на сервис"). Restricted to the actual
  // YouTube/streaming-outro phrasing whisper hallucinates, so a real meeting
  // discussing comments/subscriptions survives.
  /(ставь|поставь|стави)(те)?\s+лайк/i,
  /оставляйте?\s+комментари/i,
  /пишите\s+комментари(и|ях)\s+(ниже|под)/i,
  /оформ(ляйте|ите)\s+подписку/i,
  /не\s+забудьте\s+подписаться/i,
];

const NOISE_TOKENS: RegExp[] = [
  /\[[^\]]*\]/g,
  /\([^)]*\)/g,
  /[♪♫]/g,
];

export function cleanText(raw: string): string {
  let text = raw;

  for (const re of NOISE_TOKENS) {
    text = text.replace(re, "");
  }

  text = text.replace(/\s+/g, " ").trim();

  text = text.replace(/(\S+)(\s+\1){2,}/g, "$1");

  text = text.replace(/\.{4,}/g, "...");
  text = text.replace(/—\s*(—\s*){2,}/g, "—");

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      const lines = text.split(/(?<=[.!?])\s*/);
      text = lines.filter((l) => !pattern.test(l)).join(" ");
    }
  }

  text = text.replace(/\s+/g, " ").trim();

  if (text.length < 2) return "";

  return text;
}

export { readPcmSamples, computeRmsDb, computePeakDb };

export interface WhisperArgsOptions {
  modelPath: string;
  inputPath: string;
  outputBase: string;
  format: "txt" | "json";
  pass: "live" | "final";
  noTimestamps?: boolean;
  attendees?: string[];
}

export function buildWhisperArgs(config: Config, opts: WhisperArgsOptions): string[] {
  const isFinal = opts.pass === "final";
  const args = [
    "-m", opts.modelPath,
    "-l", config.language,
    "-f", opts.inputPath,
    opts.format === "json" ? "-oj" : "-otxt",
    "-of", opts.outputBase,
    "--suppress-nst",
    "-sow",
    "--max-len", "300",
    "--entropy-thold", String(isFinal ? config.finalEntropyThreshold : config.whisperEntropyThreshold),
    "--logprob-thold", String(isFinal ? config.finalLogprobThreshold : config.whisperLogprobThreshold),
    "--no-speech-thold", String(isFinal ? config.finalNoSpeechThreshold : config.whisperNoSpeechThreshold),
    "--no-prints",
    "--prompt", config.prompt + getVocabulary(config).toPromptSuffix(config.prompt, undefined, opts.attendees),
  ];

  if (opts.noTimestamps) {
    args.push("--no-timestamps");
  }
  if (isFinal) {
    if (config.finalBeamSize > 0) args.push("--beam-size", String(config.finalBeamSize));
    if (config.finalBestOf > 0) args.push("--best-of", String(config.finalBestOf));
  }

  return args;
}

function normalizeWav(wavBuffer: Buffer, targetDb: number = -3.0): Buffer {
  const samples = readPcmSamples(wavBuffer);
  if (samples.length === 0) return wavBuffer;

  const peak = computePeakDb(samples);
  if (peak === -Infinity) return wavBuffer;

  const gainDb = targetDb - peak;
  const gain = Math.pow(10, gainDb / 20);
  const clampedGain = Math.min(gain, 10.0);

  const out = Buffer.from(wavBuffer);
  const dataOffset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.round(samples[i] * clampedGain);
    if (s > 32767) s = 32767;
    if (s < -32768) s = -32768;
    out.writeInt16LE(s, dataOffset + i * 2);
  }
  return out;
}

export async function transcribeChunk(
  wavPath: string,
  config: Config,
  chunkIndex: number,
  source: "mic" | "sys",
  options?: TranscribeOptions
): Promise<TranscribeResult> {
  const wavBuffer = await readFile(wavPath);

  const rawSamples = readPcmSamples(wavBuffer);
  const rawRmsDb = computeRmsDb(rawSamples);
  const rawPeakDb = computePeakDb(rawSamples);
  const metrics: AudioMetrics = { rmsDb: rawRmsDb, peakDb: rawPeakDb };

  if (config.silenceGate) {
    const threshold = source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
    if (rawRmsDb < threshold) {
      return { chunkIndex, source, text: "", metrics };
    }
  }

  if (config.vadEnabled) {
    const vad = await detectSpeech(wavPath, config);
    if (!vad.speech) {
      return { chunkIndex, source, text: "", metrics };
    }
  }

  let transcribeBuffer: Buffer = wavBuffer;
  let didNormalize = false;
  if (config.normalizeForWhisper) {
    const isQuietMic = source === "mic" && rawRmsDb < (config.micRmsThresholdDb + 10);
    if (!isQuietMic) {
      transcribeBuffer = normalizeWav(wavBuffer) as Buffer;
      didNormalize = true;
    }
  }

  const modelPath = options?.modelPath
    ?? resolveModelPath(config, options?.pass ?? "live");

  let transcribePath = wavPath;
  let normalizedTmp = false;

  if (didNormalize) {
    const tmpPath = wavPath.replace(/\.wav$/, ".norm.wav");
    await writeFile(tmpPath, transcribeBuffer);
    transcribePath = tmpPath;
    normalizedTmp = true;
  }

  const baseName = transcribePath.replace(/\.wav$/, "");
  const outFile = baseName + ".txt";

  const isFinal = options?.pass === "final";

  const bin = resolveWhisperBin(config);

  const args = buildWhisperArgs(config, {
    modelPath,
    inputPath: transcribePath,
    outputBase: baseName,
    format: "txt",
    pass: options?.pass ?? "live",
    noTimestamps: !isFinal,
    attendees: options?.attendees,
  });

  // P3: lower whisper-cli's QoS so the Swift audio capture (default priority)
  // never starves during live recording. Applies to both live + final passes
  // since they share this spawn site; fail-opens when taskpolicy is unavailable.
  const { command, args: spawnArgs } = applyQoS(bin, args, config);

  const timeout = isFinal ? 300_000 : 120_000;

  return new Promise((resolve, reject) => {
    execFile(command, spawnArgs, { timeout, maxBuffer: 1024 * 1024 }, async (err) => {
      if (normalizedTmp) {
        await unlink(transcribePath).catch(() => {});
      }

      if (err) {
        reject(new Error(`whisper-cli failed for ${wavPath}: ${err.message}`));
        return;
      }

      let raw: string;
      try {
        raw = (await readFile(outFile, "utf-8")).trim();
      } catch (readErr) {
        // whisper-cli exited 0 but its output file is missing/unreadable — a
        // real I/O failure, not silence. Reject so the chunk is tracked as
        // failed (pipeline.ts marks status "failed") instead of being recorded
        // as a successful empty transcription and lost from recovery.
        reject(new Error(`whisper-cli output missing for ${wavPath}: ${readErr instanceof Error ? readErr.message : String(readErr)}`));
        return;
      }
      await unlink(outFile).catch(() => {});
      let text = cleanText(raw);
      if (text) {
        const pb = getPhrasebook(config);
        text = pb.apply(text);
      }
      resolve({ chunkIndex, source, text, metrics });
    });
  });
}

export function parseChunkFilename(filename: string): { source: "mic" | "sys"; index: number } | null {
  const match = filename.match(MIC_OR_SYS_CHUNK_RE);
  if (!match) return null;
  return { source: match[1] as "mic" | "sys", index: parseInt(match[2], 10) };
}
