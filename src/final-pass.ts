import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { copyFile } from "node:fs/promises";
import type { Session, Config, TranscriptEntry } from "./types.js";
import { loadConfig, expandPath } from "./storage.js";
import { transcribeChunk, parseChunkFilename } from "./transcriber.js";
import { analyzeWavFile } from "./audio-metrics.js";
import { filterEntries, type FinalChunkResult, type FilterConfig } from "./filters.js";
import { chunkToTimestamp } from "./assembler.js";

export async function copyLiveTranscript(outputFile: string): Promise<void> {
  const livePath = outputFile.replace(/transcript\.md$/, "transcript.live.md");
  if (existsSync(outputFile)) {
    await copyFile(outputFile, livePath);
  }
}

export async function runFinalPass(
  session: Session,
  config: Config,
  onProgress?: (done: number, total: number) => void,
  liveEntries?: TranscriptEntry[],
  beforeChunk?: () => Promise<void>,
): Promise<TranscriptEntry[]> {
  if (!existsSync(session.sessionDir)) {
    return [];
  }

  const files = await readdir(session.sessionDir);
  const wavFiles = files
    .filter((f) => /^((mic|sys)-\d{3}\.wav)$/.test(f))
    .sort();

  const finalModelPath = expandPath(config.finalModelPath || config.modelPath);

  const results: FinalChunkResult[] = [];
  let done = 0;
  const total = wavFiles.length;

  for (const wav of wavFiles) {
    const parsed = parseChunkFilename(wav);
    if (!parsed) continue;

    await beforeChunk?.();

    const wavPath = join(session.sessionDir, wav);

    const metrics = await analyzeWavFile(wavPath);

    const threshold = parsed.source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
    if (metrics.rmsDb < threshold) {
      results.push({
        source: parsed.source,
        index: parsed.index,
        wav,
        text: "",
        rmsDb: metrics.rmsDb,
        peakDb: metrics.peakDb,
      });
      done++;
      onProgress?.(done, total);
      continue;
    }

    try {
      const result = await transcribeChunk(wavPath, config, parsed.index, parsed.source, {
        modelPath: finalModelPath,
        pass: "final",
      });

      results.push({
        source: parsed.source,
        index: parsed.index,
        wav,
        text: result.text,
        rmsDb: metrics.rmsDb,
        peakDb: metrics.peakDb,
      });
    } catch {
      const liveEntry = liveEntries?.find(
        (e) => e.source === parsed.source && e.chunkIndex === parsed.index
      );
      results.push({
        source: parsed.source,
        index: parsed.index,
        wav,
        text: liveEntry?.text ?? "",
        rmsDb: metrics.rmsDb,
        peakDb: metrics.peakDb,
      });
    }

    done++;
    onProgress?.(done, total);
  }

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
