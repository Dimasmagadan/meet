import { execFile } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import type { Config, TranscribeOptions, AudioMetrics } from "./types.js";
import { readPcmSamples, computeRmsDb, computePeakDb } from "./audio-metrics.js";
import { detectSpeech } from "./vad.js";
import { getPhrasebook } from "./phrasebook.js";

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

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      const lines = text.split(/(?<=[.!?])\s*/);
      text = lines.filter((l) => !pattern.test(l)).join(" ");
    }
  }

  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export { readPcmSamples, computeRmsDb, computePeakDb };

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

  const effectiveModelPath = options?.modelPath
    ?? (options?.pass === "final" ? (config.finalModelPath || config.modelPath) : (config.liveModelPath || config.modelPath));

  const modelPath = effectiveModelPath.startsWith("~")
    ? effectiveModelPath.replace("~", process.env.HOME || "")
    : effectiveModelPath;

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
        let text = cleanText(raw);
        if (text) {
          const pb = getPhrasebook(config);
          text = pb.apply(text);
        }
        resolve({ chunkIndex, source, text, metrics });
      } catch {
        resolve({ chunkIndex, source, text: "", metrics });
      }
    });
  });
}

export function parseChunkFilename(filename: string): { source: "mic" | "sys"; index: number } | null {
  const match = filename.match(/^(mic|sys)-(\d{3})\.wav$/);
  if (!match) return null;
  return { source: match[1] as "mic" | "sys", index: parseInt(match[2], 10) };
}
