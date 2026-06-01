import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readPcmSamples,
  computeRmsDb,
  computePeakDb,
  isDigitalSilence,
  isBelowSpeechThreshold,
  makeSilentWav,
  makeSineWav,
  type AudioMetrics,
} from "./audio-metrics.js";

describe("readPcmSamples", () => {
  it("returns empty for buffer shorter than WAV header", () => {
    const result = readPcmSamples(Buffer.alloc(40));
    assert.strictEqual(result.length, 0);
  });

  it("returns empty for header-only WAV", () => {
    const buf = Buffer.alloc(44);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(0, 40);
    const result = readPcmSamples(buf);
    assert.strictEqual(result.length, 0);
  });

  it("reads samples from synthetic silent WAV", () => {
    const wav = makeSilentWav(100);
    const samples = readPcmSamples(wav);
    assert.strictEqual(samples.length, 100);
    for (let i = 0; i < samples.length; i++) {
      assert.strictEqual(samples[i], 0);
    }
  });

  it("reads samples from synthetic sine WAV", () => {
    const wav = makeSineWav(440, 100, 16000, 0.5);
    const samples = readPcmSamples(wav);
    assert.strictEqual(samples.length, 100);
    assert.ok(samples.some((s) => s !== 0));
  });
});

describe("computeRmsDb", () => {
  it("returns -Infinity for empty samples", () => {
    assert.strictEqual(computeRmsDb(new Int16Array(0)), -Infinity);
  });

  it("returns -Infinity for all-zero samples", () => {
    const wav = makeSilentWav(1000);
    const samples = readPcmSamples(wav);
    assert.strictEqual(computeRmsDb(samples), -Infinity);
  });

  it("returns finite value for non-zero samples", () => {
    const wav = makeSineWav(440, 16000, 16000, 0.5);
    const samples = readPcmSamples(wav);
    const rms = computeRmsDb(samples);
    assert.ok(Number.isFinite(rms));
    assert.ok(rms > -20);
    assert.ok(rms < 0);
  });

  it("full-amplitude sine has RMS around -3 dB", () => {
    const wav = makeSineWav(440, 16000, 16000, 1.0);
    const samples = readPcmSamples(wav);
    const rms = computeRmsDb(samples);
    assert.ok(Math.abs(rms - (-3.01)) < 0.5);
  });
});

describe("computePeakDb", () => {
  it("returns -Infinity for empty samples", () => {
    assert.strictEqual(computePeakDb(new Int16Array(0)), -Infinity);
  });

  it("returns -Infinity for all-zero samples", () => {
    const wav = makeSilentWav(1000);
    const samples = readPcmSamples(wav);
    assert.strictEqual(computePeakDb(samples), -Infinity);
  });

  it("returns 0 dB for full-amplitude signal", () => {
    const wav = makeSineWav(440, 16000, 16000, 1.0);
    const samples = readPcmSamples(wav);
    const peak = computePeakDb(samples);
    assert.ok(Math.abs(peak) < 0.5);
  });

  it("returns negative value for half-amplitude signal", () => {
    const wav = makeSineWav(440, 16000, 16000, 0.5);
    const samples = readPcmSamples(wav);
    const peak = computePeakDb(samples);
    assert.ok(peak < -5);
    assert.ok(peak > -7);
  });
});

describe("isDigitalSilence", () => {
  it("returns true for -Infinity rms and peak", () => {
    assert.strictEqual(
      isDigitalSilence({ rmsDb: -Infinity, peakDb: -Infinity, sampleCount: 100 }),
      true
    );
  });

  it("returns false for finite rms", () => {
    assert.strictEqual(
      isDigitalSilence({ rmsDb: -30, peakDb: -10, sampleCount: 100 }),
      false
    );
  });

  it("returns false when peak is finite but rms is -Infinity", () => {
    assert.strictEqual(
      isDigitalSilence({ rmsDb: -Infinity, peakDb: -10, sampleCount: 100 }),
      false
    );
  });
});

describe("isBelowSpeechThreshold", () => {
  const config = { micRmsThresholdDb: -60, sysRmsThresholdDb: -65 };

  it("returns true for digital silence on mic", () => {
    const metrics: AudioMetrics = { rmsDb: -Infinity, peakDb: -Infinity, sampleCount: 100 };
    assert.strictEqual(isBelowSpeechThreshold("mic", metrics, config), true);
  });

  it("returns true for digital silence on sys", () => {
    const metrics: AudioMetrics = { rmsDb: -Infinity, peakDb: -Infinity, sampleCount: 100 };
    assert.strictEqual(isBelowSpeechThreshold("sys", metrics, config), true);
  });

  it("returns true for mic rms below mic threshold", () => {
    const metrics: AudioMetrics = { rmsDb: -65, peakDb: -40, sampleCount: 100 };
    assert.strictEqual(isBelowSpeechThreshold("mic", metrics, config), true);
  });

  it("returns false for mic rms above mic threshold", () => {
    const metrics: AudioMetrics = { rmsDb: -30, peakDb: -10, sampleCount: 100 };
    assert.strictEqual(isBelowSpeechThreshold("mic", metrics, config), false);
  });

  it("returns true for sys rms below sys threshold", () => {
    const metrics: AudioMetrics = { rmsDb: -70, peakDb: -40, sampleCount: 100 };
    assert.strictEqual(isBelowSpeechThreshold("sys", metrics, config), true);
  });

  it("returns false for sys rms above sys threshold", () => {
    const metrics: AudioMetrics = { rmsDb: -30, peakDb: -10, sampleCount: 100 };
    assert.strictEqual(isBelowSpeechThreshold("sys", metrics, config), false);
  });

  it("uses different thresholds for mic vs sys", () => {
    const metrics: AudioMetrics = { rmsDb: -63, peakDb: -40, sampleCount: 100 };
    assert.strictEqual(isBelowSpeechThreshold("mic", metrics, config), true);
    assert.strictEqual(isBelowSpeechThreshold("sys", metrics, config), false);
  });
});

describe("makeSilentWav / makeSineWav", () => {
  it("silent WAV produces digital silence metrics", () => {
    const wav = makeSilentWav(240000);
    const samples = readPcmSamples(wav);
    assert.strictEqual(computeRmsDb(samples), -Infinity);
    assert.strictEqual(computePeakDb(samples), -Infinity);
    assert.strictEqual(samples.length, 240000);
  });

  it("sine WAV produces finite metrics", () => {
    const wav = makeSineWav(440, 240000, 16000, 0.5);
    const samples = readPcmSamples(wav);
    assert.ok(Number.isFinite(computeRmsDb(samples)));
    assert.ok(Number.isFinite(computePeakDb(samples)));
    assert.strictEqual(samples.length, 240000);
  });
});
