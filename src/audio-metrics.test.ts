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
  makeBurstWav,
  frameSizeForRate,
  frameRmsDb,
  pearsonCorrelation,
  computeMicEchoScore,
  analyzeWavFileWithSamples,
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

describe("analyzeWavFileWithSamples", () => {
  it("returns digital silence + empty samples for a missing file", async () => {
    const result = await analyzeWavFileWithSamples("/tmp/does-not-exist-meet-test.wav");
    assert.strictEqual(result.metrics.rmsDb, -Infinity);
    assert.strictEqual(result.samples.length, 0);
  });
});

describe("frameRmsDb", () => {
  it("splits samples into per-frame RMS in dB", () => {
    const wav = makeBurstWav([1, 1, 0, 0], 100, 16000, 440, 0.5);
    const samples = readPcmSamples(wav);
    const frames = frameRmsDb(samples, frameSizeForRate(16000));
    assert.strictEqual(frames.length, 4);
    // Loud frames finite and near the amplitude, silent frames at the floor.
    assert.ok(frames[0] > -20);
    assert.ok(frames[1] > -20);
    assert.ok(frames[2] < -60);
    assert.ok(frames[3] < -60);
  });

  it("returns an empty array for empty samples", () => {
    assert.deepStrictEqual(frameRmsDb(new Int16Array(0), 1600), []);
  });
});

describe("pearsonCorrelation", () => {
  it("returns ~1 for identical modulated envelopes", () => {
    const a = [1, 5, 1, 5, 1, 5];
    const r = pearsonCorrelation(a, a);
    assert.ok(Math.abs(r - 1) < 1e-9);
  });

  it("returns ~0 for uncorrelated envelopes", () => {
    const a = [1, 1, 1, 1, 5, 5, 5, 5];
    const b = [5, 5, 5, 5, 1, 1, 1, 1];
    // perfectly anti-correlated, not uncorrelated — sanity check it's -1
    assert.ok(Math.abs(pearsonCorrelation(a, b) - -1) < 1e-9);
  });

  it("returns 0 for a flat (zero-variance) signal — degenerate case makeSineWav would hit", () => {
    assert.strictEqual(pearsonCorrelation([3, 3, 3], [1, 2, 3]), 0);
  });

  it("returns 0 for empty input", () => {
    assert.strictEqual(pearsonCorrelation([], []), 0);
  });
});

describe("computeMicEchoScore", () => {
  const frameMs = 100;
  const sampleRate = 16000;
  const frameSize = frameSizeForRate(sampleRate, frameMs);
  const speechThreshold = -40;

  function framesOf(pattern: number[]): number[] {
    const wav = makeBurstWav(pattern, frameMs, sampleRate, 440, 0.5);
    return frameRmsDb(readPcmSamples(wav), frameSize);
  }

  it("identical envelope at zero lag: r ≈ 1, echoFraction ≈ 1", () => {
    const pattern = [0, 1, 1, 0, 1, 0, 1, 1];
    const micFrames = framesOf(pattern);
    const sysWindow = framesOf(pattern);
    const { correlation, echoFraction } = computeMicEchoScore(micFrames, sysWindow, speechThreshold, speechThreshold);
    assert.ok(correlation > 0.99, `expected r≈1, got ${correlation}`);
    assert.ok(echoFraction > 0.99, `expected echoFraction≈1, got ${echoFraction}`);
  });

  it("finds a delayed copy beyond a naive tens-of-ms window (wide lag search)", () => {
    const pattern = [0, 1, 1, 0, 1, 0, 1, 1, 0, 0];
    const micFrames = framesOf(pattern);
    // Sys neighbourhood: mic's chunk is delayed by 3 frames (300ms) relative
    // to where it "should" be — well beyond a tens-of-ms window, well within
    // the ±1-chunk window this function searches over.
    const delayedPattern = [0, 0, 0, ...pattern];
    const sysWindow = framesOf(delayedPattern);
    const { correlation, echoFraction } = computeMicEchoScore(micFrames, sysWindow, speechThreshold, speechThreshold);
    assert.ok(correlation > 0.99, `expected r≈1 at the found lag, got ${correlation}`);
    assert.ok(echoFraction > 0.99, `expected echoFraction≈1, got ${echoFraction}`);
  });

  it("uncorrelated bursts: r ≈ 0", () => {
    const micFrames = framesOf([1, 0, 1, 0, 1, 0, 1, 0]);
    const sysWindow = framesOf([1, 1, 0, 0, 1, 1, 0, 0]);
    const { correlation } = computeMicEchoScore(micFrames, sysWindow, speechThreshold, speechThreshold);
    assert.ok(Math.abs(correlation) < 0.1, `expected r≈0, got ${correlation}`);
  });

  it("mic = sys echo + extra bursts in sys-silent frames: high r but echoFraction stays low (overlap safety)", () => {
    // Sys neighbourhood: only frames 0 and 4 are loud (the far-end speech).
    const sysPattern = [1, 0, 0, 0, 1, 0, 0, 0];
    // Mic: same two echoed frames PLUS the user talking over frames 1-3 and
    // 5-7, where sys is silent — a real "Me" utterance overlapping the echo.
    const micPattern = [1, 1, 1, 1, 1, 1, 1, 1];
    const micFrames = framesOf(micPattern);
    const sysWindow = framesOf(sysPattern);
    const { echoFraction } = computeMicEchoScore(micFrames, sysWindow, speechThreshold, speechThreshold);
    // Only 2 of the 8 audible mic frames have an audible aligned sys frame.
    assert.ok(echoFraction < 0.9, `expected echoFraction below fMin, got ${echoFraction}`);
  });

  it("returns zero score when the sys window is shorter than the mic frames", () => {
    const micFrames = framesOf([1, 1, 1, 1]);
    const result = computeMicEchoScore(micFrames, [1, 1], speechThreshold, speechThreshold);
    assert.deepStrictEqual(result, { correlation: 0, echoFraction: 0 });
  });
});
