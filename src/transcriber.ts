import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import type { Config } from "./types.js";

export interface TranscribeResult {
  chunkIndex: number;
  source: "mic" | "sys";
  text: string;
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
];

const NOISE_TOKENS: RegExp[] = [
  /\[[^\]]*\]/g,
  /\([^)]*\)/g,
  /[♪♫]/g,
];

function cleanText(raw: string): string {
  let text = raw;

  for (const re of NOISE_TOKENS) {
    text = text.replace(re, "");
  }

  text = text.replace(/\s+/g, " ").trim();

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      const lines = text.split(/(?<=[.!?])\s*/);
      text = lines.filter((l) => !pattern.test(l)).join(" ");
    }
  }

  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function readPcmSamples(wavBuffer: Buffer): Int16Array {
  if (wavBuffer.length < 44) return new Int16Array(0);
  const dataLen = wavBuffer.readUInt32LE(40);
  const dataOffset = 44;
  const numSamples = Math.floor(dataLen / 2);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = wavBuffer.readInt16LE(dataOffset + i * 2);
  }
  return samples;
}

function computeRmsDb(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768.0;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms === 0) return -Infinity;
  return 20 * Math.log10(rms);
}

function computePeakDb(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return -Infinity;
  return 20 * Math.log10(peak / 32768.0);
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
  source: "mic" | "sys"
): Promise<TranscribeResult> {
  const wavBuffer = await readFile(wavPath);
  const samples = readPcmSamples(wavBuffer);

  if (config.silenceGate) {
    const rmsDb = computeRmsDb(samples);
    const threshold = source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
    if (rmsDb < threshold) {
      return { chunkIndex, source, text: "" };
    }
  }

  const modelPath = config.modelPath.startsWith("~")
    ? config.modelPath.replace("~", process.env.HOME || "")
    : config.modelPath;

  let transcribePath = wavPath;
  let normalizedTmp = false;

  if (config.normalizeForWhisper) {
    const normalized = normalizeWav(wavBuffer);
    const tmpPath = wavPath.replace(/\.wav$/, ".norm.wav");
    await writeFile(tmpPath, normalized);
    transcribePath = tmpPath;
    normalizedTmp = true;
  }

  const baseName = transcribePath.replace(/\.wav$/, "");
  const outFile = baseName + ".txt";

  const args = [
    "-m", modelPath,
    "-l", config.language,
    "-f", transcribePath,
    "--no-timestamps",
    "-otxt",
    "-of", baseName,
    "--suppress-nst",
    "--entropy-thold", String(config.whisperEntropyThreshold),
    "--logprob-thold", String(config.whisperLogprobThreshold),
    "--no-speech-thold", String(config.whisperNoSpeechThreshold),
    "--no-prints",
    "--prompt", config.prompt,
  ];

  return new Promise((resolve, reject) => {
    execFile(config.whisperBin, args, { timeout: 120_000, maxBuffer: 1024 * 1024 }, async (err) => {
      if (normalizedTmp) {
        await unlink(transcribePath).catch(() => {});
      }

      if (err) {
        reject(new Error(`whisper-cli failed for ${wavPath}: ${err.message}`));
        return;
      }

      try {
        const raw = (await readFile(outFile, "utf-8")).trim();
        await unlink(outFile).catch(() => {});
        const text = cleanText(raw);
        resolve({ chunkIndex, source, text });
      } catch {
        resolve({ chunkIndex, source, text: "" });
      }
    });
  });
}

export function parseChunkFilename(filename: string): { source: "mic" | "sys"; index: number } | null {
  const match = filename.match(/^(mic|sys)-(\d{3})\.wav$/);
  if (!match) return null;
  return { source: match[1] as "mic" | "sys", index: parseInt(match[2], 10) };
}
