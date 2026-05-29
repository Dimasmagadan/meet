import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Session, Config, TranscriptEntry, FinalizeProgress } from "./types.js";
import { loadConfig, expandPath, writeAtomic } from "./storage.js";
import { Pipeline } from "./pipeline.js";
import { copyLiveTranscript, runFinalPass } from "./final-pass.js";
import { entriesFromSession, rewriteMarkdown, parseTranscriptEntries, transcriptEntriesToMap } from "./assembler.js";
import { acquireFinalizerLock, releaseFinalizerLock, isActiveRecording } from "./locks.js";

const PROGRESS_WRITE_INTERVAL_MS = 1000;

export interface FinalizeOptions {
  foreground: boolean;
  pauseForActiveRecording: boolean;
  onProgress?: (msg: string) => void;
}

export interface FinalizeResult {
  session: Session;
  entries: TranscriptEntry[];
  warnings: string[];
}

function makeProgress(phase: FinalizeProgress["phase"], done: number, total: number, message: string | null = null): FinalizeProgress {
  return { phase, done, total, message, pid: process.pid, updatedAt: new Date().toISOString() };
}

function createDebouncedProgressWriter(session: Session) {
  let lastWriteTime = 0;
  let pendingProgress: FinalizeProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (pendingProgress) {
      session.finalize = pendingProgress;
      await writeAtomic(join(session.sessionDir, "session.json"), JSON.stringify(session, null, 2)).catch(() => {});
      pendingProgress = null;
    }
    timer = null;
  };

  const update = async (progress: FinalizeProgress) => {
    session.finalize = progress;
    pendingProgress = progress;
    const now = Date.now();
    if (now - lastWriteTime >= PROGRESS_WRITE_INTERVAL_MS) {
      lastWriteTime = now;
      await flush();
    } else if (!timer) {
      timer = setTimeout(() => { lastWriteTime = Date.now(); void flush(); }, PROGRESS_WRITE_INTERVAL_MS);
    }
  };

  const forceFlush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    lastWriteTime = Date.now();
    await flush();
  };

  return { update, forceFlush };
}

async function waitForInactiveRecording(onProgress?: (msg: string) => void): Promise<void> {
  while (isActiveRecording()) {
    onProgress?.("Paused: active recording, waiting...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export async function finalizeSession(
  sessionDir: string,
  options: FinalizeOptions,
): Promise<FinalizeResult> {
  const sessionPath = join(sessionDir, "session.json");
  if (!existsSync(sessionPath)) {
    throw new Error(`No session found: ${sessionDir}`);
  }

  const session: Session = JSON.parse(await readFile(sessionPath, "utf-8"));
  const config = loadConfig();

  if (session.status === "done") {
    return { session, entries: [], warnings: ["Session already finalized"] };
  }

  if (!acquireFinalizerLock(sessionDir)) {
    throw new Error("Finalizer already running for this session");
  }

  const log = options.onProgress ?? (() => {});
  const warnings: string[] = [];
  const warn = (msg: string) => { warnings.push(msg); log(msg); };
  const progressWriter = createDebouncedProgressWriter(session);

  try {
    session.status = "finalizing";
    await progressWriter.update(makeProgress("stopping", 0, 0));

    const pipeline = new Pipeline(session);

    const liveResults = new Map<string, string>();
    pipeline.setTranscribeCallback((source, index, text) => {
      const key = `${source}-${String(index).padStart(3, "0")}`;
      liveResults.set(key, text);
    });

    await pipeline.stop(async (progress) => {
      await progressWriter.update(makeProgress("live", progress.done, progress.total));
      log(`Live pass: ${progress.done}/${progress.total}`);
    });

    const refreshedSession: Session = JSON.parse(await readFile(sessionPath, "utf-8"));
    session.processedChunks = refreshedSession.processedChunks;
    session.tags = refreshedSession.tags ?? session.tags;

    for (const [k, v] of pipeline.getResults()) {
      liveResults.set(k, v);
    }

    if (config.keepLiveTranscript) {
      try { await copyLiveTranscript(session.outputFile); } catch {}
    }

    let fallbackEntries: TranscriptEntry[] = [];
    try {
      const existing = await readFile(session.outputFile, "utf-8").catch(() => "");
      if (existing) fallbackEntries = parseTranscriptEntries(existing, { chunkDurationSeconds: session.chunkDurationSeconds, startedAt: session.startedAt });
    } catch {}

    let entries: TranscriptEntry[];

    if (config.finalRetranscribe) {
      const finalModelPath = expandPath(config.finalModelPath || config.modelPath);
      if (!existsSync(finalModelPath)) {
        warn(`Final model not found: ${finalModelPath}, using live transcript`);
        const mergedResults = new Map([...transcriptEntriesToMap(fallbackEntries), ...liveResults]);
        entries = entriesFromSession(session, mergedResults);
        if (entries.length === 0 && fallbackEntries.length > 0) entries = fallbackEntries;
      } else {
        try {
          log(`Final high-quality pass (${config.finalModelPath.replace(/^.*\//, "")})...`);

          const beforeChunk = options.pauseForActiveRecording
            ? async () => { await waitForInactiveRecording(log); }
            : undefined;

          const mergedResults = new Map([...transcriptEntriesToMap(fallbackEntries), ...liveResults]);
          entries = await runFinalPass(session, config, (done, total) => {
            progressWriter.update(makeProgress("final", done, total));
            log(`Final pass: ${done}/${total} chunks`);
          }, entriesFromSession(session, mergedResults), beforeChunk);
        } catch (err) {
          warn(`Final pass failed: ${err instanceof Error ? err.message : String(err)}, using live transcript`);
          const mergedResults = new Map([...transcriptEntriesToMap(fallbackEntries), ...liveResults]);
          entries = entriesFromSession(session, mergedResults);
          if (entries.length === 0 && fallbackEntries.length > 0) entries = fallbackEntries;
        }
      }
    } else {
      const mergedResults = new Map([...transcriptEntriesToMap(fallbackEntries), ...liveResults]);
      entries = entriesFromSession(session, mergedResults);
      if (entries.length === 0 && fallbackEntries.length > 0) entries = fallbackEntries;
    }

    await progressWriter.update(makeProgress("write", entries.length, entries.length));
    await progressWriter.forceFlush();

    if (entries.length > 0) {
      if (fallbackEntries.length > 0 && entries.length < fallbackEntries.length) {
        warn(`Final pass produced ${entries.length} entries vs ${fallbackEntries.length} in live transcript, keeping live`);
        entries = fallbackEntries;
      }
      await rewriteMarkdown(session.outputFile, session.title, session.startedAt, entries);
    }

    session.status = "done";
    session.finalize = makeProgress("done", entries.length, entries.length);
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

    log(`Done: ${session.outputFile}`);
    log(`Transcribed ${entries.length} segments`);

    return { session, entries, warnings };
  } catch (err) {
    session.status = "error";
    session.lastError = err instanceof Error ? err.message : String(err);
    session.finalize = makeProgress("error", 0, 0, session.lastError);
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2)).catch(() => {});
    throw err;
  } finally {
    releaseFinalizerLock(sessionDir);
  }
}
