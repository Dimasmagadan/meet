import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { copyFile } from "node:fs/promises";
import type { Session, Config, TranscriptEntry } from "./types.js";
import { loadConfig, resolveModelPath } from "./storage.js";
import { transcribeChunk, parseChunkFilename } from "./transcriber.js";
import {
  analyzeWavFileWithSamples,
  frameSizeForRate,
  frameRmsDb,
  computeMicEchoScore,
  type AudioMetrics,
} from "./audio-metrics.js";
import { filterEntries, type FinalChunkResult, type FilterConfig } from "./filters.js";
import { chunkToTimestamp } from "./assembler.js";
import { makeDeadline, whenNotOverloaded, type PressureSensor } from "./system-monitor.js";
import { MIC_OR_SYS_CHUNK_RE, sortChunkFilenames } from "./regex-utils.js";

export async function copyLiveTranscript(outputFile: string): Promise<void> {
  const livePath = outputFile.replace(/transcript\.md$/, "transcript.live.md");
  if (existsSync(outputFile)) {
    await copyFile(outputFile, livePath);
  }
}

export interface AudibleChunk {
  source: "mic" | "sys";
  index: number;
  wav: string;
  wavPath: string;
  metrics: AudioMetrics;
  // false when below the source's silence-gate threshold — callers should
  // skip transcription but still account for the chunk in their own results.
  audible: boolean;
  // Raw PCM, read once here so callers needing more than the summary metrics
  // (e.g. the P2 echo envelope) don't re-read the file. Not retained by this
  // function itself.
  samples: Int16Array;
}

// Shared chunk-iteration shape for any full re-transcription pass (whisper
// final pass, Parakeet A/B pass): same file listing, same silence gating, so
// both passes see exactly the same chunk set and their outputs are
// comparable apples-to-apples.
export async function forEachAudibleChunk(
  session: Session,
  config: Config,
  onChunk: (chunk: AudibleChunk, done: number, total: number) => Promise<void>,
  beforeChunk?: () => Promise<void>,
): Promise<void> {
  if (!existsSync(session.sessionDir)) return;

  const files = await readdir(session.sessionDir);
  const wavFiles = sortChunkFilenames(files.filter((f) => MIC_OR_SYS_CHUNK_RE.test(f)));

  const total = wavFiles.length;
  let done = 0;

  for (const wav of wavFiles) {
    const parsed = parseChunkFilename(wav);
    if (!parsed) continue;

    await beforeChunk?.();

    const wavPath = join(session.sessionDir, wav);
    const { metrics, samples } = await analyzeWavFileWithSamples(wavPath);
    const threshold = parsed.source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
    const audible = metrics.rmsDb >= threshold;

    done++;
    await onChunk({ source: parsed.source, index: parsed.index, wav, wavPath, metrics, audible, samples }, done, total);
  }
}

export interface FinalPassResult {
  entries: TranscriptEntry[];
  // Keys (`${source}-${paddedIndex}`) of mic entries dropped as cross-channel
  // echo (P1 coverage or P2 audio score) — the finalize safety net excludes
  // these from its "did the final pass lose entries" comparison, since
  // effective echo filtering is supposed to shrink the entry count.
  droppedEchoKeys: Set<string>;
}

export async function runFinalPass(
  session: Session,
  config: Config,
  onProgress?: (done: number, total: number) => void,
  liveEntries?: TranscriptEntry[],
  beforeChunk?: () => Promise<void>,
  sensor?: PressureSensor,
): Promise<FinalPassResult> {
  const finalModelPath = resolveModelPath(config, "final");
  const results: FinalChunkResult[] = [];

  // Per-~100ms-frame RMS envelope, keyed by chunk index (P2). Frame arrays are
  // tiny (~150 floats per 15s chunk) — kept for the whole meeting, unlike the
  // raw samples they're derived from, which are discarded after each chunk.
  const frameSize = frameSizeForRate(16000);
  const micFramesByIndex = new Map<number, number[]>();
  const sysFramesByIndex = new Map<number, number[]>();

  // One wall-clock budget for the whole pass, threaded into every per-chunk
  // gate check so a many-chunk pass can't stall N × maxWaitMs. Live path is
  // un-gated; only this batch (medium-model) pass backs off under load.
  const gate = config.gateHeavyPasses ? makeDeadline(config.gateBudgetMs) : null;

  await forEachAudibleChunk(session, config, async (chunk, done, total) => {
    if (gate) await whenNotOverloaded(gate, sensor);

    const frames = frameRmsDb(chunk.samples, frameSize);
    (chunk.source === "mic" ? micFramesByIndex : sysFramesByIndex).set(chunk.index, frames);

    if (!chunk.audible) {
      results.push({
        source: chunk.source,
        index: chunk.index,
        wav: chunk.wav,
        text: "",
        rmsDb: chunk.metrics.rmsDb,
        peakDb: chunk.metrics.peakDb,
      });
      onProgress?.(done, total);
      return;
    }

    try {
      const result = await transcribeChunk(chunk.wavPath, config, chunk.index, chunk.source, {
        modelPath: finalModelPath,
        pass: "final",
        attendees: session.attendees,
      });

      results.push({
        source: chunk.source,
        index: chunk.index,
        wav: chunk.wav,
        text: result.text,
        rmsDb: chunk.metrics.rmsDb,
        peakDb: chunk.metrics.peakDb,
      });
    } catch {
      const liveEntry = liveEntries?.find(
        (e) => e.source === chunk.source && e.chunkIndex === chunk.index
      );
      results.push({
        source: chunk.source,
        index: chunk.index,
        wav: chunk.wav,
        text: liveEntry?.text ?? "",
        rmsDb: chunk.metrics.rmsDb,
        peakDb: chunk.metrics.peakDb,
      });
    }

    onProgress?.(done, total);
  }, beforeChunk);

  // P2: lag-search each mic chunk's envelope against its sys {N-1,N,N+1}
  // neighbourhood (mirrors the P1 text window). Only chunks whose best
  // correlation clears the threshold get a micEchoScore at all — filters.ts
  // then drops on echoFraction, which is what stays safe under overlap.
  for (const r of results) {
    if (r.source !== "mic") continue;
    const micFrames = micFramesByIndex.get(r.index);
    if (!micFrames || micFrames.length === 0) continue;

    const sysWindow = [
      ...(sysFramesByIndex.get(r.index - 1) ?? []),
      ...(sysFramesByIndex.get(r.index) ?? []),
      ...(sysFramesByIndex.get(r.index + 1) ?? []),
    ];
    if (sysWindow.length === 0) continue;

    const { correlation, echoFraction } = computeMicEchoScore(
      micFrames,
      sysWindow,
      config.micRmsThresholdDb,
      config.sysRmsThresholdDb
    );
    if (correlation >= config.micEchoCorrelationThreshold) {
      r.micEchoScore = echoFraction;
    }
  }

  const filterConfig: FilterConfig = {
    micRmsThresholdDb: config.micRmsThresholdDb,
    micEchoCoverageThreshold: config.micEchoCoverageThreshold,
    micEchoFractionThreshold: config.micEchoFractionThreshold,
  };

  const droppedEcho: FinalChunkResult[] = [];
  const filtered = filterEntries(results, filterConfig, droppedEcho);
  const droppedEchoKeys = new Set(
    droppedEcho.map((r) => `${r.source}-${String(r.index).padStart(3, "0")}`)
  );

  const entries = filtered
    .filter((r) => r.text)
    .map((r) => ({
      source: r.source,
      chunkIndex: r.index,
      timestamp: chunkToTimestamp(r.index, session.chunkDurationSeconds, session.startedAt),
      text: r.text,
    }));

  return { entries, droppedEchoKeys };
}
