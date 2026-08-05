import { readFile } from "node:fs/promises";

export interface AudioMetrics {
  rmsDb: number;
  peakDb: number;
  sampleCount: number;
}

export function readPcmSamples(wavBuffer: Buffer): Int16Array {
  if (wavBuffer.length < 44) return new Int16Array(0);
  const headerDataLen = wavBuffer.readUInt32LE(40);
  const actualDataLen = wavBuffer.length - 44;
  const dataLen = Math.min(headerDataLen, actualDataLen);
  const numSamples = Math.floor(dataLen / 2);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = wavBuffer.readInt16LE(44 + i * 2);
  }
  return samples;
}

export function computeRmsDb(samples: Int16Array): number {
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

export function computePeakDb(samples: Int16Array): number {
  if (samples.length === 0) return -Infinity;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return -Infinity;
  return 20 * Math.log10(peak / 32768.0);
}

export function isDigitalSilence(metrics: AudioMetrics): boolean {
  return metrics.rmsDb === -Infinity && metrics.peakDb === -Infinity;
}

export function isBelowSpeechThreshold(
  source: "mic" | "sys",
  metrics: AudioMetrics,
  config: { micRmsThresholdDb: number; sysRmsThresholdDb: number }
): boolean {
  if (isDigitalSilence(metrics)) return true;
  const threshold = source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
  return metrics.rmsDb < threshold;
}

export interface WavAnalysis {
  metrics: AudioMetrics;
  samples: Int16Array;
}

export async function analyzeWavFileWithSamples(wavPath: string): Promise<WavAnalysis> {
  try {
    const buf = await readFile(wavPath);
    const samples = readPcmSamples(buf);
    return {
      metrics: {
        rmsDb: computeRmsDb(samples),
        peakDb: computePeakDb(samples),
        sampleCount: samples.length,
      },
      samples,
    };
  } catch {
    return { metrics: { rmsDb: -Infinity, peakDb: -Infinity, sampleCount: 0 }, samples: new Int16Array(0) };
  }
}

export async function analyzeWavFile(wavPath: string): Promise<AudioMetrics> {
  return (await analyzeWavFileWithSamples(wavPath)).metrics;
}

// P2 echo gate (SPEC_MIC_ECHO_FILTERING_2026-08-05): per-~100ms-frame RMS
// envelope. Frame arrays are tiny (~150 floats per 15s chunk) so they can be
// retained for a whole meeting without the memory cost of keeping raw samples.
const SILENCE_FLOOR_DB = -90;

export function frameSizeForRate(sampleRate: number, frameMs: number = 100): number {
  return Math.max(1, Math.round((sampleRate * frameMs) / 1000));
}

export function frameRmsDb(samples: Int16Array, frameSize: number): number[] {
  const frames: number[] = [];
  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(start + frameSize, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i] / 32768.0;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / (end - start));
    frames.push(rms === 0 ? SILENCE_FLOOR_DB : Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(rms)));
  }
  return frames;
}

// Mean-subtracted, variance-normalised — scale-invariant, which matters
// because the echo is an attenuated copy of the original.
export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let num = 0;
  let denomA = 0;
  let denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  if (denomA === 0 || denomB === 0) return 0;
  return num / Math.sqrt(denomA * denomB);
}

export interface EchoScoreResult {
  correlation: number;
  echoFraction: number;
}

// Searches every offset in sysWindow (the sys {N-1,N,N+1} neighbourhood
// envelope, same locality as the P1 text check) for the best-correlated
// alignment with micFrames, then computes echoFraction only at that lag:
// the share of *audible* mic frames whose aligned sys frame is also audible.
// A chunk where the user talks over the far end has mic energy in frames
// where sys is silent, so echoFraction — not correlation — is what protects
// genuine "Me" speech from being dropped.
export function computeMicEchoScore(
  micFrames: number[],
  sysWindow: number[],
  micSpeechThresholdDb: number,
  sysSpeechThresholdDb: number
): EchoScoreResult {
  if (micFrames.length === 0 || sysWindow.length < micFrames.length) {
    return { correlation: 0, echoFraction: 0 };
  }

  let bestR = -Infinity;
  let bestStart = 0;
  for (let start = 0; start <= sysWindow.length - micFrames.length; start++) {
    const candidate = sysWindow.slice(start, start + micFrames.length);
    const r = pearsonCorrelation(micFrames, candidate);
    if (r > bestR) {
      bestR = r;
      bestStart = start;
    }
  }
  if (bestR === -Infinity) return { correlation: 0, echoFraction: 0 };

  const aligned = sysWindow.slice(bestStart, bestStart + micFrames.length);
  let micAudible = 0;
  let bothAudible = 0;
  for (let i = 0; i < micFrames.length; i++) {
    if (micFrames[i] >= micSpeechThresholdDb) {
      micAudible++;
      if (aligned[i] >= sysSpeechThresholdDb) bothAudible++;
    }
  }
  const echoFraction = micAudible === 0 ? 0 : bothAudible / micAudible;
  return { correlation: bestR, echoFraction };
}

export function makeSilentWav(durationSamples: number = 240000): Buffer {
  const dataSize = durationSamples * 2;
  const header = makeWavHeader(dataSize, 16000, 1, 16);
  const data = Buffer.alloc(dataSize, 0);
  return Buffer.concat([header, data]);
}

export function makeSineWav(
  frequency: number = 440,
  durationSamples: number = 240000,
  sampleRate: number = 16000,
  amplitude: number = 0.5
): Buffer {
  const dataSize = durationSamples * 2;
  const header = makeWavHeader(dataSize, sampleRate, 1, 16);
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < durationSamples; i++) {
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude;
    const val = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    data.writeInt16LE(val, i * 2);
  }
  return Buffer.concat([header, data]);
}

// Amplitude-modulated bursts (tone on/off per ~frameMs frame) — a steady
// sine's envelope is flat (zero variance, degenerate for Pearson); this one
// modulates so correlation/echoFraction tests exercise a realistic envelope.
export function makeBurstWav(
  pattern: number[],
  frameMs: number = 100,
  sampleRate: number = 16000,
  frequency: number = 440,
  amplitude: number = 0.5
): Buffer {
  const frameSamples = Math.round((sampleRate * frameMs) / 1000);
  const durationSamples = pattern.length * frameSamples;
  const dataSize = durationSamples * 2;
  const header = makeWavHeader(dataSize, sampleRate, 1, 16);
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < durationSamples; i++) {
    const frameIdx = Math.floor(i / frameSamples);
    const amp = amplitude * (pattern[frameIdx] ?? 0);
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amp;
    const val = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    data.writeInt16LE(val, i * 2);
  }
  return Buffer.concat([header, data]);
}

export function makeWavHeader(dataSize: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}
