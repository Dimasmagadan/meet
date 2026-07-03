import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { copyFile } from "node:fs/promises";
import type { Session, Config, TranscriptEntry } from "./types.js";
import { loadConfig, resolveModelPath } from "./storage.js";
import { transcribeChunk, parseChunkFilename } from "./transcriber.js";
import { analyzeWavFile, type AudioMetrics } from "./audio-metrics.js";
import { filterEntries, type FinalChunkResult, type FilterConfig } from "./filters.js";
import { chunkToTimestamp } from "./assembler.js";

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
  const wavFiles = files
    .filter((f) => /^((mic|sys)-\d{3}\.wav)$/.test(f))
    .sort();

  const total = wavFiles.length;
  let done = 0;

  for (const wav of wavFiles) {
    const parsed = parseChunkFilename(wav);
    if (!parsed) continue;

    await beforeChunk?.();

    const wavPath = join(session.sessionDir, wav);
    const metrics = await analyzeWavFile(wavPath);
    const threshold = parsed.source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
    const audible = metrics.rmsDb >= threshold;

    done++;
    await onChunk({ source: parsed.source, index: parsed.index, wav, wavPath, metrics, audible }, done, total);
  }
}

export async function runFinalPass(
  session: Session,
  config: Config,
  onProgress?: (done: number, total: number) => void,
  liveEntries?: TranscriptEntry[],
  beforeChunk?: () => Promise<void>,
): Promise<TranscriptEntry[]> {
  const finalModelPath = resolveModelPath(config, "final");
  const results: FinalChunkResult[] = [];

  await forEachAudibleChunk(session, config, async (chunk, done, total) => {
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

  const filterConfig: FilterConfig = {
    micRmsThresholdDb: config.micRmsThresholdDb,
  };

  const filtered = filterEntries(results, filterConfig);

  return filtered
    .filter((r) => r.text)
    .map((r) => ({
      source: r.source,
      chunkIndex: r.index,
      timestamp: chunkToTimestamp(r.index, session.chunkDurationSeconds, session.startedAt),
      text: r.text,
    }));
}
