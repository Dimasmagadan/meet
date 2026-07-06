import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Session, Config, TranscriptEntry, FinalizeProgress, EntryRecord } from "./types.js";
import { loadConfig, resolveModelPath, resolveAnalysisBin, writeAtomic } from "./storage.js";
import { Pipeline } from "./pipeline.js";
import { copyLiveTranscript, runFinalPass } from "./final-pass.js";
import { entriesFromSession, rewriteMarkdown, parseTranscriptEntries, transcriptEntriesToMap } from "./assembler.js";
import { acquireFinalizerLock, releaseFinalizerLock, isActiveRecording, acquireGlobalFinalPassLock, releaseGlobalFinalPassLock, readGlobalFinalPassLock } from "./locks.js";
import { analyzeWavFile } from "./audio-metrics.js";
import { readEntryRecords } from "./entries-store.js";
import { concatSysChunks, runDiarizer, assignSpeakers, relabelSegments, cleanupSysConcat, type DiarSegment } from "./diarization.js";
import { computeTalkTime } from "./talk-time.js";
import { runParakeetPass } from "./parakeet-pass.js";

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

async function filterEntriesByAudio(
  entries: TranscriptEntry[],
  session: Session,
  config: Config,
): Promise<TranscriptEntry[]> {
  const filtered: TranscriptEntry[] = [];

  for (const entry of entries) {
    const wav = `${entry.source}-${String(entry.chunkIndex).padStart(3, "0")}.wav`;
    const wavPath = join(session.sessionDir, wav);
    const metrics = await analyzeWavFile(wavPath);
    const threshold = entry.source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
    if (metrics.rmsDb >= threshold) {
      filtered.push(entry);
    }
  }

  return filtered;
}

function filterStoredEntriesByAudio(
  entries: TranscriptEntry[],
  stored: Map<string, number>,
  config: Config,
): TranscriptEntry[] {
  const filtered: TranscriptEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.source}-${String(entry.chunkIndex).padStart(3, "0")}`;
    const rmsDb = stored.get(key) ?? -Infinity;
    const threshold = entry.source === "mic" ? config.micRmsThresholdDb : config.sysRmsThresholdDb;
    if (rmsDb >= threshold) {
      filtered.push(entry);
    }
  }

  return filtered;
}

// Merges the three text sources finalization can recover, lowest priority first:
// entries.jsonl (survives even if this process never touched the chunk) <
// markdown fallback (only used when entries.jsonl is empty) < in-process live results
// (this run's own drain, always freshest).
export function buildBaseResults(
  storedRecords: EntryRecord[],
  fallbackEntries: TranscriptEntry[],
  liveResults: Map<string, string>,
): Map<string, string> {
  const storedTextMap = new Map(
    storedRecords
      .filter((r) => r.text)
      .map((r) => [`${r.source}-${String(r.index).padStart(3, "0")}`, r.text] as const)
  );
  return new Map([...storedTextMap, ...transcriptEntriesToMap(fallbackEntries), ...liveResults]);
}

async function waitForInactiveRecording(
  session: Session,
  phase: FinalizeProgress["phase"],
  progressWriter: ReturnType<typeof createDebouncedProgressWriter>,
  onProgress?: (msg: string) => void,
): Promise<void> {
  while (isActiveRecording()) {
    session.status = "paused";
    await progressWriter.update(makeProgress("paused", session.finalize?.done ?? 0, session.finalize?.total ?? 0, "active recording, waiting"));
    onProgress?.("Paused: active recording, waiting...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (session.status === "paused") {
    session.status = "finalizing";
    await progressWriter.update(makeProgress(phase, session.finalize?.done ?? 0, session.finalize?.total ?? 0));
  }
}

async function waitForGlobalFinalPassSlot(
  sessionDir: string,
  session: Session,
  progressWriter: ReturnType<typeof createDebouncedProgressWriter>,
  onProgress?: (msg: string) => void,
): Promise<void> {
  while (!acquireGlobalFinalPassLock(sessionDir)) {
    const existing = readGlobalFinalPassLock();
    const msg = existing ? `waiting for final pass in ${existing.sessionDir}` : "waiting for final pass lock";
    session.status = "paused";
    await progressWriter.update(makeProgress("paused", session.finalize?.done ?? 0, session.finalize?.total ?? 0, msg));
    onProgress?.(`Paused: ${msg}...`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (session.status === "paused") {
    session.status = "finalizing";
    await progressWriter.update(makeProgress("final", session.finalize?.done ?? 0, session.finalize?.total ?? 0));
  }
}

interface DiarizationOutcome {
  entries: TranscriptEntry[];
  segments: DiarSegment[];
  speakersRecord: Record<string, unknown>;
}

// Diarizes sys-source entries into "Speaker N" labels (F1). Fails open: any
// error leaves entries unmodified and records the failure in speakers.json
// instead of throwing, so diarization never blocks finalization.
export async function runDiarizationStep(
  session: Session,
  config: Config,
  entries: TranscriptEntry[],
  warn: (msg: string) => void,
  log: (msg: string) => void,
): Promise<DiarizationOutcome> {
  const speakersRecord: Record<string, unknown> = {
    version: 1,
    sessionId: session.id,
    diarization: { ok: false },
  };

  if (!config.diarizationEnabled) return { entries, segments: [], speakersRecord };
  if (session.mode !== "full") return { entries, segments: [], speakersRecord };
  if (!entries.some((e) => e.source === "sys")) return { entries, segments: [], speakersRecord };

  const analysisBin = resolveAnalysisBin(config);
  if (!existsSync(analysisBin)) {
    warn(`Diarization skipped: AudioAnalysis binary not found at ${analysisBin}, keeping Others labels`);
    speakersRecord.diarization = { ok: false, error: "AudioAnalysis binary not found" };
    return { entries, segments: [], speakersRecord };
  }

  let sysFileCount = 0;
  try {
    const files = await readdir(session.sessionDir);
    sysFileCount = files.filter((f) => /^sys-\d{3}\.wav$/.test(f)).length;
  } catch {
    return { entries, segments: [], speakersRecord };
  }
  if (sysFileCount === 0) return { entries, segments: [], speakersRecord };

  const startedAt = Date.now();
  try {
    log("Diarization pass...");
    const { wavPath, offsets } = await concatSysChunks(session.sessionDir);
    try {
      const rawSegments = await runDiarizer(config, wavPath);
      const segments = relabelSegments(rawSegments);
      const diarizedEntries = assignSpeakers(entries, segments, offsets, config.diarizationMinOverlap);
      const speakerIds = new Set(segments.map((s) => s.speaker));

      speakersRecord.diarization = { ok: true, speakerCount: speakerIds.size, binaryMs: Date.now() - startedAt };
      speakersRecord.segments = segments;
      speakersRecord.entryAssignments = diarizedEntries
        .filter((e) => e.source === "sys")
        .map((e) => ({ chunkIndex: e.chunkIndex, speaker: e.speaker ?? null }));

      return { entries: diarizedEntries, segments, speakersRecord };
    } finally {
      await cleanupSysConcat(session.sessionDir);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Diarization failed: ${message}, keeping Others labels`);
    speakersRecord.diarization = { ok: false, error: message };
    return { entries, segments: [], speakersRecord };
  }
}

// Re-transcribes the session with Parakeet for a side-by-side quality/speed
// comparison (F3). Fails open: any error just skips the A/B artifacts —
// transcript.md was already written and is unaffected.
async function runParakeetComparisonStep(
  session: Session,
  config: Config,
  outputDir: string,
  speakersRecord: Record<string, unknown>,
  whisperWallMs: number,
  warn: (msg: string) => void,
  log: (msg: string) => void,
  progressWriter: ReturnType<typeof createDebouncedProgressWriter>,
): Promise<void> {
  const analysisBin = resolveAnalysisBin(config);
  if (!existsSync(analysisBin)) return;

  try {
    log("Parakeet A/B pass...");
    await progressWriter.update(makeProgress("ab", 0, 0));

    const speakerByChunk = new Map<number, string>();
    const entryAssignments = speakersRecord.entryAssignments as
      | Array<{ chunkIndex: number; speaker: string | null }>
      | undefined;
    for (const assignment of entryAssignments ?? []) {
      if (assignment.speaker) speakerByChunk.set(assignment.chunkIndex, assignment.speaker);
    }

    const result = await runParakeetPass(session, config, speakerByChunk, (done, total) => {
      progressWriter.update(makeProgress("ab", done, total));
      log(`Parakeet A/B pass: ${done}/${total} chunks`);
    });

    if (result.failedChunks > 0) {
      warn(`Parakeet A/B pass: ${result.failedChunks}/${result.chunks} chunks failed to transcribe`);
    }

    const parakeetPath = session.outputFile.replace(/transcript\.md$/, "transcript.parakeet.md");
    await rewriteMarkdown(parakeetPath, `${session.title} — Parakeet A/B`, session.startedAt, result.entries);

    const abReport = {
      date: new Date().toISOString(),
      chunks: result.chunks,
      whisper: { model: config.finalModelPath.replace(/^.*\//, ""), wallMs: whisperWallMs },
      parakeet: { model: "FluidInference/parakeet-tdt-0.6b-v3-coreml", wallMs: result.wallMs },
      notes: "compare transcript.md vs transcript.parakeet.md",
    };
    await writeAtomic(join(outputDir, "ab-report.json"), JSON.stringify(abReport, null, 2)).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Parakeet A/B pass failed: ${message}, main transcript unaffected`);
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

    const finalModelPath = resolveModelPath(config, "final");
    const willRunFinalPass = config.finalRetranscribe && existsSync(finalModelPath);

    if (willRunFinalPass) {
      // The final pass re-transcribes every chunk with the higher-quality model,
      // so draining pending chunks with the live model first would just double
      // the whisper-cli runs for no benefit.
      await pipeline.close();
    } else {
      const liveBeforeChunk = options.pauseForActiveRecording
        ? async () => { await waitForInactiveRecording(session, "live", progressWriter, log); }
        : undefined;

      await pipeline.stop(async (progress) => {
        await progressWriter.update(makeProgress("live", progress.done, progress.total));
        log(`Live pass: ${progress.done}/${progress.total}`);
      }, liveBeforeChunk);
    }

    const refreshedSession: Session = JSON.parse(await readFile(sessionPath, "utf-8"));
    session.processedChunks = refreshedSession.processedChunks;
    session.tags = refreshedSession.tags ?? session.tags;

    for (const [k, v] of pipeline.getResults()) {
      liveResults.set(k, v);
    }

    if (config.keepLiveTranscript) {
      try { await copyLiveTranscript(session.outputFile); } catch {}
    }

    // Load stored entries from entries.jsonl (more reliable than parsing markdown)
    const storedRecords = await readEntryRecords(sessionDir);
    const storedRmsMap = new Map(storedRecords.map((r) => [`${r.source}-${String(r.index).padStart(3, "0")}`, r.rmsDb]));

    let fallbackEntries: TranscriptEntry[] = [];
    try {
      // Fallback: try to parse transcript.md if entries.jsonl is missing/incomplete
      const existing = await readFile(session.outputFile, "utf-8").catch(() => "");
      if (existing && storedRecords.length === 0) {
        fallbackEntries = parseTranscriptEntries(existing, { chunkDurationSeconds: session.chunkDurationSeconds, startedAt: session.startedAt });
      }
    } catch {}

    let entries: TranscriptEntry[];

    // Base results merge entries.jsonl (survives even chunks this process never
    // touched), the transcript.md fallback, and this run's own live drain.
    const baseResults = buildBaseResults(storedRecords, fallbackEntries, liveResults);
    const sessionEntries = entriesFromSession(session, baseResults);
    // Non-silent candidate entries from stored+live text — used both as the
    // fallback when the final pass is unavailable/fails, and as the safety-net
    // comparison below (previously compared only against markdown, which is
    // empty whenever entries.jsonl exists).
    const baseEntries = filterStoredEntriesByAudio(sessionEntries, storedRmsMap, config);

    const fallbackAudioEntries = async (): Promise<TranscriptEntry[]> => {
      if (baseEntries.length > 0) return baseEntries;
      if (fallbackEntries.length > 0) return filterEntriesByAudio(fallbackEntries, session, config);
      return [];
    };

    let finalPassLocked = false;
    let finalPassWallMs = 0;
    try {
      if (config.finalRetranscribe) {
        if (!existsSync(finalModelPath)) {
          warn(`Final model not found: ${finalModelPath}, using live transcript`);
          entries = await fallbackAudioEntries();
        } else {
          // Wait for global final-pass slot (only one big-model pass at a time)
          await waitForGlobalFinalPassSlot(sessionDir, session, progressWriter, log);
          finalPassLocked = true;

          try {
            log(`Final high-quality pass (${config.finalModelPath.replace(/^.*\//, "")})...`);

            const beforeChunk = options.pauseForActiveRecording
              ? async () => { await waitForInactiveRecording(session, "final", progressWriter, log); }
              : undefined;

            const finalPassStartedAt = Date.now();
            entries = await runFinalPass(session, config, (done, total) => {
              progressWriter.update(makeProgress("final", done, total));
              log(`Final pass: ${done}/${total} chunks`);
            }, sessionEntries, beforeChunk);
            finalPassWallMs = Date.now() - finalPassStartedAt;
          } catch (err) {
            warn(`Final pass failed: ${err instanceof Error ? err.message : String(err)}, using live transcript`);
            entries = await fallbackAudioEntries();
          }
        }
      } else {
        entries = await fallbackAudioEntries();
      }

      await progressWriter.update(makeProgress("write", entries.length, entries.length));
      await progressWriter.forceFlush();

      if (entries.length > 0) {
        if (baseEntries.length > 0 && entries.length < baseEntries.length) {
          warn(`Final pass produced ${entries.length} entries vs ${baseEntries.length} non-silent live/stored entries, keeping live`);
          entries = baseEntries;
        }

        await progressWriter.update(makeProgress("diarize", 0, 0));
        const { entries: diarizedEntries, segments, speakersRecord } = await runDiarizationStep(session, config, entries, warn, log);
        entries = diarizedEntries;

        const talkTime = computeTalkTime({
          entryRecords: storedRecords,
          chunkDurationSeconds: session.chunkDurationSeconds,
          micRmsThresholdDb: config.micRmsThresholdDb,
          sysRmsThresholdDb: config.sysRmsThresholdDb,
          diarSegments: segments,
        });
        speakersRecord.talkTime = talkTime;

        const outputDir = dirname(session.outputFile);
        await writeAtomic(join(outputDir, "speakers.json"), JSON.stringify(speakersRecord, null, 2)).catch(() => {});

        await rewriteMarkdown(session.outputFile, session.title, session.startedAt, entries, talkTime);

        if (config.parakeetComparePass) {
          await runParakeetComparisonStep(session, config, outputDir, speakersRecord, finalPassWallMs, warn, log, progressWriter);
        }
      }
    } finally {
      if (finalPassLocked) {
        releaseGlobalFinalPassLock();
      }
    }

    session.status = "done";
    session.finalize = makeProgress("done", entries.length, entries.length);
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

    await rm(sessionDir, { recursive: true, force: true }).catch(() => {});

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
