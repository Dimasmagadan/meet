import { execFile } from "node:child_process";
import type { Session, Config, TranscriptEntry } from "./types.js";
import { forEachAudibleChunk } from "./final-pass.js";
import { chunkToTimestamp } from "./assembler.js";
import { resolveAnalysisBin } from "./storage.js";
import { getPhrasebook } from "./phrasebook.js";
import { makeDeadline, whenNotOverloaded, type PressureSensor } from "./system-monitor.js";
import { applyQoS } from "./process-priority.js";

export async function transcribeWithParakeet(config: Config, wavPath: string): Promise<string> {
  const bin = resolveAnalysisBin(config);
  const { command, args } = applyQoS(bin, ["transcribe", "--input", wavPath, "--language", config.language], config);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`AudioAnalysis transcribe failed: ${err.message}${stderr ? ` (${stderr.trim()})` : ""}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

  // The CoreML/E5RT runtime can print extra diagnostic lines to stdout after
  // our JSON line; only the first line is ours to parse.
  const firstLine = stdout.split("\n", 1)[0];
  const parsed = JSON.parse(firstLine) as { text: string };
  return parsed.text;
}

export interface ParakeetPassResult {
  entries: TranscriptEntry[];
  chunks: number;
  wallMs: number;
  failedChunks: number;
}

// Re-transcribes the same audible chunk set as the whisper final pass with
// Parakeet, for direct quality/speed A/B comparison (F3). Only the phrasebook
// is applied — whisper-specific hallucination filtering and the mic
// duplicate/acknowledgement filters are intentionally skipped so each
// engine's raw output is what gets compared. Best-effort: a chunk that fails
// to transcribe is simply omitted, never fails the pass.
export async function runParakeetPass(
  session: Session,
  config: Config,
  speakerByChunk: Map<string, string>,
  onProgress?: (done: number, total: number) => void,
  sensor?: PressureSensor,
): Promise<ParakeetPassResult> {
  const entries: TranscriptEntry[] = [];
  const startedAt = Date.now();
  let chunkCount = 0;
  let failedChunks = 0;

  // One wall-clock budget for the whole A/B pass; threaded into each per-chunk
  // gate check so the total back-off is bounded. Batch pass only.
  const gate = config.gateHeavyPasses ? makeDeadline(config.gateBudgetMs) : null;

  await forEachAudibleChunk(session, config, async (chunk, done, total) => {
    onProgress?.(done, total);
    if (gate) await whenNotOverloaded(gate, sensor);
    if (!chunk.audible) return;
    chunkCount++;

    let text: string;
    try {
      text = await transcribeWithParakeet(config, chunk.wavPath);
    } catch {
      failedChunks++;
      return;
    }

    text = text.trim();
    if (text) {
      const phrasebook = getPhrasebook(config);
      text = phrasebook.apply(text);
    }
    if (!text) return;

    const timestamp = chunkToTimestamp(chunk.index, session.chunkDurationSeconds, session.startedAt);
    const speaker = chunk.source === "sys" ? speakerByChunk.get(`sys-${chunk.index}`) : undefined;
    entries.push({
      source: chunk.source,
      chunkIndex: chunk.index,
      timestamp,
      text,
      ...(speaker ? { speaker } : {}),
    });
  });

  entries.sort((a, b) => (a.chunkIndex !== b.chunkIndex ? a.chunkIndex - b.chunkIndex : (a.source === "mic" ? -1 : 1)));

  return { entries, chunks: chunkCount, wallMs: Date.now() - startedAt, failedChunks };
}
