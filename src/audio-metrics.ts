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

export async function analyzeWavFile(wavPath: string): Promise<AudioMetrics> {
  try {
    const buf = await readFile(wavPath);
    const samples = readPcmSamples(buf);
    return {
      rmsDb: computeRmsDb(samples),
      peakDb: computePeakDb(samples),
      sampleCount: samples.length,
    };
  } catch {
    return { rmsDb: -Infinity, peakDb: -Infinity, sampleCount: 0 };
  }
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
