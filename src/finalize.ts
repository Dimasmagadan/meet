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
import { concatSysChunks, runDiarizer, assignSpeakers, relabelSegments, cleanupSysConcat, buildSpeakerLabelMap, buildEmbeddingsByLabel, type DiarSegment } from "./diarization.js";
import { runDiarizationAbPass } from "./diarization-ab.js";
import { computeTalkTime } from "./talk-time.js";
import type { TalkTimeStats } from "./talk-time.js";

// Re-applies the registry's display-name overrides to the Talk Time footer
// rows. `computeTalkTime` reads canonical "Speaker N" labels off the segments
// (which deliberately stay canonical for `meet rename` validation), but the
// body's entry labels were overridden by `applySpeakerRegistry`. Without this,
// the footer sticks on "Speaker 1" while the body says "Женя" — and rename
// can't repair it because speakerNames maps canonical→name, so the rename
// regex looks for a label the file never had.
export function applyLabelOverridesToTalkTime(
  stats: TalkTimeStats,
  labelOverrides: Map<string, string>,
): TalkTimeStats {
  if (labelOverrides.size === 0) return stats;
  const speakers = stats.speakers.map((row) => {
    const override = labelOverrides.get(row.label);
    return override ? { ...row, label: override } : row;
  });
  return { ...stats, speakers };
}
import { runParakeetPass } from "./parakeet-pass.js";
import { appendPostFinalizeNote } from "./summary.js";
import { runOpencodeIndex } from "./opencode.js";
import { makeDeadline, whenNotOverloaded, type PressureSensor } from "./system-monitor.js";
import { loadRegistry, saveRegistry, applyRegistryToSpeakers, appendMatchesLog, matchesLogPath } from "./speaker-registry.js";

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
  // canonical "Speaker N" -> display name (only populated when the registry
  // matched a named voice). The caller applies this to the Talk Time footer
  // rows so the footer stays in sync with the body, which already had entry
  // labels overridden inside this step.
  labelOverrides: Map<string, string>;
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
  sensor?: PressureSensor,
): Promise<DiarizationOutcome> {
  const speakersRecord: Record<string, unknown> = {
    version: 1,
    sessionId: session.id,
    diarization: { ok: false },
  };
  // §6.1 — the calendar-supplied attendee list, so `meet speakers suggest` (§6.3)
  // has a candidate name list even when diarization itself is disabled/failed.
  if (session.attendees && session.attendees.length > 0) {
    speakersRecord.calendarAttendees = session.attendees;
  }

  if (!config.diarizationEnabled) return { entries, segments: [], speakersRecord, labelOverrides: new Map() };
  if (session.mode !== "full") return { entries, segments: [], speakersRecord, labelOverrides: new Map() };
  if (!entries.some((e) => e.source === "sys")) return { entries, segments: [], speakersRecord, labelOverrides: new Map() };

  const analysisBin = resolveAnalysisBin(config);
  if (!existsSync(analysisBin)) {
    warn(`Diarization skipped: AudioAnalysis binary not found at ${analysisBin}, keeping Others labels`);
    speakersRecord.diarization = { ok: false, error: "AudioAnalysis binary not found" };
    return { entries, segments: [], speakersRecord, labelOverrides: new Map() };
  }

  let sysFileCount = 0;
  try {
    const files = await readdir(session.sessionDir);
    sysFileCount = files.filter((f) => /^sys-\d{3}\.wav$/.test(f)).length;
  } catch {
    return { entries, segments: [], speakersRecord, labelOverrides: new Map() };
  }
  if (sysFileCount === 0) return { entries, segments: [], speakersRecord, labelOverrides: new Map() };

  const startedAt = Date.now();
  try {
    log("Diarization pass...");
    const { wavPath, offsets } = await concatSysChunks(session.sessionDir);
    try {
      // Single heavy CoreML call — one gate check with the whole diarize as
      // its budget. Batch pass only; never blocks the live path.
      if (config.gateHeavyPasses) {
        await whenNotOverloaded(makeDeadline(config.gateBudgetMs), sensor);
      }
      const { segments: rawSegments, embeddings: rawEmbeddings } = await runDiarizer(config, wavPath);
      const segments = relabelSegments(rawSegments);
      const diarizedEntries = assignSpeakers(entries, segments, offsets, config.diarizationMinOverlap);
      const speakerIds = new Set(segments.map((s) => s.speaker));

      speakersRecord.diarization = { ok: true, speakerCount: speakerIds.size, binaryMs: Date.now() - startedAt };
      // Canonical segments stay in "Speaker N" form so `meet rename` can still
      // validate the requested id; display-name overrides land in entry labels +
      // speakerNames instead.
      speakersRecord.segments = segments;

      // Cross-session registry: match/register voices against prior meetings.
      // On a match with a known name, rewrites entry.speaker to that name so the
      // transcript + parakeet A/B both display it. Fails open (warns, never blocks).
      const labelOverrides = await applySpeakerRegistry(session, config, rawSegments, rawEmbeddings, diarizedEntries, speakersRecord, warn);

      speakersRecord.entryAssignments = diarizedEntries
        .filter((e) => e.source === "sys")
        .map((e) => ({ chunkIndex: e.chunkIndex, speaker: e.speaker ?? null }));

      if (config.diarizationAbPass) {
        await runDiarizationAbStep(session, config, wavPath, segments, rawSegments, rawEmbeddings, warn, log, sensor);
      }

      return { entries: diarizedEntries, segments, speakersRecord, labelOverrides };
    } finally {
      await cleanupSysConcat(session.sessionDir);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Diarization failed: ${message}, keeping Others labels`);
    speakersRecord.diarization = { ok: false, error: message };
    return { entries, segments: [], speakersRecord, labelOverrides: new Map() };
  }
}

// Matches/registers each diarized speaker's embedding against the cross-session
// registry (S1). When a matched voice already has a name, rewrites the matching
// entries' speaker label to that name (transcript + parakeet both display it).
// Persists globalSpeakerId/matchedName per canonical "Speaker N" into
// speakers.json so `meet rename` can later patch the registry entry. No-op when
// the registry is disabled or no embeddings were emitted. Fails open.
// Returns the labelOverrides so the caller can also patch the Talk Time footer
// (computed against canonical segments, which deliberately stay "Speaker N").
async function applySpeakerRegistry(
  session: Session,
  config: Config,
  rawSegments: DiarSegment[],
  rawEmbeddings: Record<string, number[]>,
  diarizedEntries: TranscriptEntry[],
  speakersRecord: Record<string, unknown>,
  warn: (msg: string) => void,
): Promise<Map<string, string>> {
  if (!config.speakerRegistryEnabled) return new Map();
  if (Object.keys(rawEmbeddings).length === 0) return new Map();

  const rawToLabel = buildSpeakerLabelMap(rawSegments);
  const embeddingsByLabel = new Map<string, number[]>();
  for (const [rawId, emb] of Object.entries(rawEmbeddings)) {
    const label = rawToLabel.get(rawId);
    if (label && Array.isArray(emb) && emb.length > 0) embeddingsByLabel.set(label, emb);
  }
  if (embeddingsByLabel.size === 0) return new Map();

  try {
    const registry = loadRegistry(config.speakerRegistryPath);
    const { labelOverrides, speakerMeta, matches } = applyRegistryToSpeakers(
      embeddingsByLabel,
      session.id,
      registry,
      config.speakerMatchThreshold,
      "diarizer-manager",
    );
    await saveRegistry(registry, config.speakerRegistryPath);
    await appendMatchesLog(matchesLogPath(config.speakerRegistryPath), matches).catch(() => {});

    if (labelOverrides.size > 0) {
      for (let i = 0; i < diarizedEntries.length; i++) {
        const e = diarizedEntries[i];
        if (e.source === "sys" && e.speaker && labelOverrides.has(e.speaker)) {
          diarizedEntries[i] = { ...e, speaker: labelOverrides.get(e.speaker)! };
        }
      }
      const speakerNames: Record<string, string> = {};
      for (const [label, name] of labelOverrides) speakerNames[label] = name;
      speakersRecord.speakerNames = speakerNames;
    }

    const speakerRegistry: Record<string, { globalSpeakerId: string; matchedName: string | null; score: number }> = {};
    for (const [label, meta] of speakerMeta) {
      speakerRegistry[label] = { globalSpeakerId: meta.globalSpeakerId, matchedName: meta.matchedName, score: meta.score };
    }
    speakersRecord.speakerRegistry = speakerRegistry;

    return labelOverrides;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Speaker registry update failed: ${message}`);
    return new Map();
  }
}

// Re-diarizes sys-concat.wav with the offline VBx pipeline for a measured A/B
// against the primary online result, writing diarization-ab-report.json (S2).
// Runs while sys-concat.wav is still on disk (caller cleans it up right after
// this returns). Fails open: any error just skips the report — the primary
// diarization already landed in speakersRecord and is unaffected.
async function runDiarizationAbStep(
  session: Session,
  config: Config,
  wavPath: string,
  primarySegments: DiarSegment[],
  rawPrimarySegments: DiarSegment[],
  rawPrimaryEmbeddings: Record<string, number[]>,
  warn: (msg: string) => void,
  log: (msg: string) => void,
  sensor?: PressureSensor,
): Promise<void> {
  try {
    log("Diarization A/B pass...");
    const primaryEmbeddingsByLabel = buildEmbeddingsByLabel(rawPrimarySegments, rawPrimaryEmbeddings);
    const report = await runDiarizationAbPass(config, wavPath, primarySegments, primaryEmbeddingsByLabel, sensor);
    const outputDir = dirname(session.outputFile);
    await writeAtomic(join(outputDir, "diarization-ab-report.json"), JSON.stringify(report, null, 2)).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Diarization A/B pass failed: ${message}, primary diarization unaffected`);
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
        const { entries: diarizedEntries, segments, speakersRecord, labelOverrides } = await runDiarizationStep(session, config, entries, warn, log);
        entries = diarizedEntries;

        const talkTime = applyLabelOverridesToTalkTime(
          computeTalkTime({
            entryRecords: storedRecords,
            chunkDurationSeconds: session.chunkDurationSeconds,
            micRmsThresholdDb: config.micRmsThresholdDb,
            sysRmsThresholdDb: config.sysRmsThresholdDb,
            diarSegments: segments,
          }),
          labelOverrides,
        );
        speakersRecord.talkTime = talkTime;

        const outputDir = dirname(session.outputFile);
        await writeAtomic(join(outputDir, "speakers.json"), JSON.stringify(speakersRecord, null, 2)).catch(() => {});

        await rewriteMarkdown(session.outputFile, session.title, session.startedAt, entries, talkTime);

        // Post-finalize note: stamp summary.md (if present) so the reader knows
        // the draft used live Me/Others labels while transcript.md got Speaker N.
        await appendPostFinalizeNote(session);

        if (config.parakeetComparePass) {
          await runParakeetComparisonStep(session, config, outputDir, speakersRecord, finalPassWallMs, warn, log, progressWriter);
        }

        if (config.opencodeIndexPass) {
          try {
            log("Generating index (opencode)...");
            const indexMarkdown = await runOpencodeIndex(config, session.outputFile, session.title);
            await writeAtomic(join(outputDir, "index.md"), indexMarkdown);
          } catch (err) {
            warn(`Index generation failed: ${err instanceof Error ? err.message : String(err)}, transcript unaffected`);
          }
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
