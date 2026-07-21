import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import type { Session, TranscriptEntry } from "./types.js";
import { writeAtomic } from "./storage.js";
import type { ResourcePressure } from "./system-monitor.js";

export const MIN_ENTRIES_FOR_SUMMARY = 8;
export const DEFAULT_WINDOW_MAX_ENTRIES = 200;
export const DEFAULT_TOP_N = 5;
const TEXTRANK_ITERATIONS = 20;
const TEXTRANK_DAMPING = 0.85;
const TEXTRANK_TOLERANCE = 1e-6;

const ACTION_ITEM_REGEX = /(нужно|надо|сделаем|сделать|дедлайн|deadline|todo|задача|вернёмся|вернемся|обсудим|до\s+(\d|пятниц|сред|понедельник|вторник|суббот|воскрес|через|завтр|недел|конц|вечер|утр)|\bк\s+\d{1,2}\b|\bк\s+пятнице\b|\bк\s+среде\b)/i;

const STOPWORDS = new Set<string>([
  // Russian
  "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то", "все", "она",
  "так", "его", "но", "да", "ты", "к", "у", "же", "вы", "за", "бы", "по", "только", "ее",
  "мне", "было", "вот", "от", "меня", "о", "из", "ему", "теперь", "когда", "даже", "ну",
  "вдруг", "ли", "если", "уже", "или", "ни", "быть", "был", "него", "до", "вас", "нибудь",
  "опять", "уж", "вам", "ведь", "там", "потом", "себя", "ничего", "ей", "может", "они",
  "тут", "где", "есть", "надо", "ней", "для", "мы", "тебя", "их", "чем", "была", "сам",
  "чтоб", "без", "будто", "чего", "раз", "тоже", "себе", "под", "будет", "ж", "тогда", "кто",
  "этот", "того", "потому", "этого", "какой", "совсем", "ним", "здесь", "этом", "один",
  "почти", "мой", "тем", "чтобы", "нее", "сейчас", "были", "куда", "зачем", "всех", "никогда",
  "можно", "при", "наконец", "два", "об", "другой", "хоть", "после", "над", "больше", "то",
  "какая", "каком", "каждый", "весь", "способ", "это", "эти", "лишь",
  // English
  "the", "a", "an", "and", "or", "but", "if", "of", "at", "by", "for", "with", "about",
  "against", "between", "into", "through", "during", "before", "after", "above", "below",
  "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "can", "will", "just", "don", "should", "now", "i",
  "me", "my", "we", "our", "you", "your", "he", "him", "his", "she", "her", "it", "its",
  "they", "them", "their", "what", "which", "who", "this", "that", "these", "those", "am",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
  "did", "would", "could", "should", "may", "might", "must", "shall",
]);

export interface SummaryResult {
  windowStartIndex: number;
  windowEndIndex: number;
  keyPoints: TranscriptEntry[];
  candidateActions: TranscriptEntry[];
  participants: string[];
  generatedAt: string;
}

export interface ExtractSummaryOptions {
  topN?: number;
  minEntries?: number;
  maxWindowEntries?: number;
}

interface ScoredSentence {
  entryIdx: number;
  sentenceIdx: number;
  text: string;
  score: number;
}

function splitSentences(text: string): string[] {
  // Split on . ! ? … — and Russian punctuation, keep non-empty trimmed sentences.
  const parts = text.split(/[.!?…—]+/);
  return parts
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

function tokenize(text: string): string[] {
  // Lowercase, strip punctuation, drop stopwords and short tokens.
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-zа-яё0-9]+/gi) ?? [];
  return tokens.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function buildSentenceVectors(sentences: string[]): Map<string, number>[] {
  return sentences.map((s) => {
    const counts = new Map<string, number>();
    for (const tok of tokenize(s)) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
    return counts;
  });
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const [k, v] of a) {
    magA += v * v;
    const w = b.get(k);
    if (w !== undefined) dot += v * w;
  }
  for (const [, v] of b) magB += v * v;
  if (magA === 0 || magB === 0) return 0;
  return dot / Math.sqrt(magA * magB);
}

// TextRank via power iteration on a normalized sentence-similarity graph.
function textRank(similarity: number[][], n: number): number[] {
  // Build row-normalized stochastic matrix with damping.
  const transition: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const s = similarity[i][j];
      transition[i][j] = s > 0 ? s : 0;
      rowSum += transition[i][j];
    }
    if (rowSum === 0) {
      // Dangling row: distribute uniformly (minus self) to avoid rank sink.
      const uniform = (1 - TEXTRANK_DAMPING) / Math.max(1, n - 1);
      for (let j = 0; j < n; j++) {
        if (i !== j) transition[i][j] = uniform;
      }
      continue;
    }
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      transition[i][j] = (TEXTRANK_DAMPING * transition[i][j]) / rowSum
        + (1 - TEXTRANK_DAMPING) / Math.max(1, n - 1);
    }
  }

  let scores = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < TEXTRANK_ITERATIONS; iter++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        sum += transition[j][i] * scores[j];
      }
      next[i] = sum;
    }
    // Check convergence.
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - scores[i]);
    scores = next;
    if (delta < TEXTRANK_TOLERANCE) break;
  }
  return scores;
}

export function extractSummary(
  entries: TranscriptEntry[],
  options: ExtractSummaryOptions = {},
): SummaryResult {
  const topN = options.topN ?? DEFAULT_TOP_N;
  const minEntries = options.minEntries ?? MIN_ENTRIES_FOR_SUMMARY;
  const maxWindow = options.maxWindowEntries ?? DEFAULT_WINDOW_MAX_ENTRIES;

  const generatedAt = new Date().toISOString();

  if (entries.length === 0) {
    return {
      windowStartIndex: 0,
      windowEndIndex: 0,
      keyPoints: [],
      candidateActions: [],
      participants: [],
      generatedAt,
    };
  }

  // Sliding window: last maxWindowEntries.
  const start = Math.max(0, entries.length - maxWindow);
  const windowEntries = entries.slice(start);
  const windowStartIndex = windowEntries.length > 0 ? windowEntries[0].chunkIndex : 0;
  const windowEndIndex = windowEntries.length > 0
    ? windowEntries[windowEntries.length - 1].chunkIndex
    : 0;

  const participants = deriveParticipants(windowEntries);

  // Below floor: return metadata only, no key points.
  if (entries.length < minEntries) {
    return {
      windowStartIndex,
      windowEndIndex,
      keyPoints: [],
      candidateActions: [],
      participants,
      generatedAt,
    };
  }

  // Sentence split per entry, keeping entry attribution.
  const scoredSentences: ScoredSentence[] = [];
  const sentencesPerEntry: string[][] = windowEntries.map((e) => splitSentences(e.text));

  // Flatten and build vectors only if we have at least 2 sentences total.
  const flatSentences: { entryIdx: number; text: string }[] = [];
  for (let i = 0; i < sentencesPerEntry.length; i++) {
    for (const s of sentencesPerEntry[i]) {
      flatSentences.push({ entryIdx: i, text: s });
    }
  }

  let entryScores: number[];
  if (flatSentences.length < 2) {
    // Too few sentences for TextRank: fall back to chronological pick of first N entries.
    entryScores = windowEntries.map(() => 1 / Math.max(1, windowEntries.length));
  } else {
    const vectors = buildSentenceVectors(flatSentences.map((s) => s.text));
    const n = vectors.length;
    const similarity: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 0 : cosineSim(vectors[i], vectors[j]))),
    );
    const sentenceScores = textRank(similarity, n);

    // Aggregate per-entry max sentence score.
    entryScores = windowEntries.map(() => 0);
    for (let i = 0; i < n; i++) {
      const entryIdx = flatSentences[i].entryIdx;
      if (sentenceScores[i] > entryScores[entryIdx]) {
        entryScores[entryIdx] = sentenceScores[i];
      }
    }
  }

  // Pick top-N entries by score, then re-sort chronologically.
  const indexed = windowEntries.map((entry, idx) => ({ entry, idx, score: entryScores[idx] }));
  indexed.sort((a, b) => b.score - a.score);
  const topPicked = indexed.slice(0, Math.min(topN, indexed.length));
  topPicked.sort((a, b) => a.idx - b.idx);
  const keyPoints = topPicked.map((p) => p.entry);

  // Action-item candidates: regex over raw entry text.
  const candidateActions = windowEntries.filter((e) => ACTION_ITEM_REGEX.test(e.text));

  return {
    windowStartIndex,
    windowEndIndex,
    keyPoints,
    candidateActions,
    participants,
    generatedAt,
  };
}

function deriveParticipants(entries: TranscriptEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    let label: string;
    if (e.source === "mic") label = "Me";
    else if (e.source === "sys") label = e.speaker ?? "Others";
    else label = e.speaker ?? "Others"; // "file" — harmless for live recording
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

// Format identical to assembler.ts:formatEntry — kept in sync so a summary line
// pastes verbatim into a transcript search. Mirrors the Me / Others / Speaker N
// rules used by the live recording.
function formatSummaryEntry(entry: TranscriptEntry): string {
  if (entry.source === "file") {
    return `**[${entry.timestamp}]** ${entry.text}`;
  }
  const label = entry.source === "mic" ? "Me" : (entry.speaker ?? "Others");
  return `**[${entry.timestamp}] ${label}:** ${entry.text}`;
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const FOOTER = `
---

> Draft produced locally by extractive summarization. Final, higher-quality summary can be generated on demand with \`meet summary --full\` (post-finalize, future spec).
`;

export function formatSummaryMarkdown(
  result: SummaryResult,
  title: string,
  startedAt: string,
  options: { chunkCount?: number; chunkDurationSeconds?: number } = {},
): string {
  const date = new Date(startedAt);
  const dateStr = date.toLocaleDateString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit" });
  const timeStr = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const header = `# ${title} — Summary (draft)\n\n`;

  const generated = formatTimeOfDay(result.generatedAt);
  const chunkDur = options.chunkDurationSeconds ?? 15;
  // When the window covers no entries yet, fall back to the meeting header date.
  // Otherwise compute the HH:MM:SS–HH:MM:SS range from chunk indices + startedAt
  // so the label stays accurate across sliding windows.
  const headerFallback = `${dateStr} ${timeStr}`;
  const windowLabel = (result.windowStartIndex === 0 && result.windowEndIndex === 0)
    ? headerFallback
    : `${chunkIndexToTimeOfDay(result.windowStartIndex, startedAt, chunkDur)} – ${chunkIndexToTimeOfDay(result.windowEndIndex, startedAt, chunkDur)}`;
  const chunkLabel = options.chunkCount !== undefined ? ` · **Chunks:** ${options.chunkCount}` : "";
  const meta = `**Generated:** ${generated} · **Window:** ${windowLabel}${chunkLabel}\n\n`;

  const parts: string[] = [header, meta];

  parts.push(`## Key points\n\n`);
  if (result.keyPoints.length === 0) {
    parts.push(`_(not enough transcript yet — gathering more chunks)_\n\n`);
  } else {
    for (const entry of result.keyPoints) {
      parts.push(formatSummaryEntry(entry) + "\n\n");
    }
  }

  parts.push(`## Candidate action items\n\n`);
  if (result.candidateActions.length === 0) {
    parts.push(`_(none detected — these are heuristic guesses)_\n\n`);
  } else {
    for (const entry of result.candidateActions) {
      parts.push(formatSummaryEntry(entry) + "\n\n");
    }
  }

  parts.push(`## Participants\n\n`);
  parts.push(result.participants.length > 0 ? result.participants.join(", ") + "\n\n" : `_(none yet)_\n\n`);

  parts.push(FOOTER);

  return parts.join("");
}

function chunkIndexToTimeOfDay(chunkIndex: number, startedAt: string, chunkDurationSeconds: number): string {
  const start = new Date(startedAt);
  const offsetMs = Math.max(0, chunkIndex - 1) * chunkDurationSeconds * 1000;
  const t = new Date(start.getTime() + offsetMs);
  const h = String(t.getHours()).padStart(2, "0");
  const m = String(t.getMinutes()).padStart(2, "0");
  const s = String(t.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SummarySchedulerOptions {
  session: Session;
  outputFile: string;
  intervalChunks: number;
  catchupIntervalMs: number;
  minEntries: number;
  topN: number;
  maxWindowEntries: number;
  warn: (msg: string, err?: unknown) => void;
  getEntries: () => TranscriptEntry[];
  getPressure: () => Promise<ResourcePressure>;
}

export class SummaryScheduler {
  private readonly opts: SummarySchedulerOptions;
  private chunkCounter = 0;
  private dirty = false;
  private disabled = false;
  private inFlightRun: Promise<void> | null = null;
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private lastPressure: ResourcePressure | null = null;

  constructor(opts: SummarySchedulerOptions) {
    this.opts = opts;
  }

  onChunk(_source: "mic" | "sys", _index: number): void {
    if (this.disabled) return;
    this.chunkCounter++;
    if (this.chunkCounter >= this.opts.intervalChunks) {
      this.chunkCounter = 0;
      void this.maybeRun();
    }
  }

  // Pressure-check then summarize if OK. Stores its own Promise in
  // inFlightRun so flush() can await the run. Coalesces overlapping calls.
  private maybeRun(): Promise<void> {
    if (this.inFlightRun) {
      // Already running — mark dirty so the next tick re-runs.
      this.dirty = true;
      this.ensureCatchupTimer();
      return this.inFlightRun;
    }
    const p = (async () => {
      try {
        const pressure = await this.opts.getPressure();
        this.lastPressure = pressure;
        if (pressure.overloaded) {
          this.opts.warn(`summary paused (${pressure.reason ?? "system load"})`);
          this.dirty = true;
          this.ensureCatchupTimer();
          return;
        }
        const entries = this.opts.getEntries();
        if (entries.length < this.opts.minEntries) {
          // Empty-window early-out: do NOT write the file, do NOT set dirty.
          return;
        }
        const result = extractSummary(entries, {
          topN: this.opts.topN,
          minEntries: this.opts.minEntries,
          maxWindowEntries: this.opts.maxWindowEntries,
        });
        const markdown = formatSummaryMarkdown(
          result,
          this.opts.session.title,
          this.opts.session.startedAt,
          {
            chunkCount: entries.length,
            chunkDurationSeconds: this.opts.session.chunkDurationSeconds,
          },
        );
        await writeAtomic(this.opts.outputFile, markdown);
        this.dirty = false;
        this.stopCatchupTimer();
      } catch (err) {
        this.disabled = true;
        this.dirty = false;
        this.stopCatchupTimer();
        this.opts.warn("summary disabled", err);
      }
    })();
    this.inFlightRun = p.finally(() => {
      this.inFlightRun = null;
    });
    return this.inFlightRun;
  }

  private ensureCatchupTimer(): void {
    if (this.catchupTimer) return;
    this.catchupTimer = setInterval(() => {
      if (!this.dirty) {
        this.stopCatchupTimer();
        return;
      }
      void this.maybeRun();
    }, this.opts.catchupIntervalMs);
    // Do not keep the event loop alive solely for catch-up retry.
    if (typeof this.catchupTimer.unref === "function") {
      this.catchupTimer.unref();
    }
  }

  private stopCatchupTimer(): void {
    if (this.catchupTimer) {
      clearInterval(this.catchupTimer);
      this.catchupTimer = null;
    }
  }

  // Shutdown path: await any in-flight run, then run once ignoring gates.
  async flush(): Promise<void> {
    if (this.disabled) {
      this.stopCatchupTimer();
      return;
    }
    try {
      this.stopCatchupTimer();
      if (this.inFlightRun) {
        await this.inFlightRun;
      }
      // Force a run that ignores both the intervalChunks gate and overload.
      const entries = this.opts.getEntries();
      if (entries.length < this.opts.minEntries) {
        return;
      }
      const result = extractSummary(entries, {
        topN: this.opts.topN,
        minEntries: this.opts.minEntries,
        maxWindowEntries: this.opts.maxWindowEntries,
      });
      const markdown = formatSummaryMarkdown(
        result,
        this.opts.session.title,
        this.opts.session.startedAt,
        {
          chunkCount: entries.length,
          chunkDurationSeconds: this.opts.session.chunkDurationSeconds,
        },
      );
      await writeAtomic(this.opts.outputFile, markdown);
      this.dirty = false;
    } catch (err) {
      // Never propagate into the recording path.
      this.opts.warn("summary flush failed", err);
    } finally {
      this.stopCatchupTimer();
    }
  }

  // Exposed for status-line rendering.
  getLastPressure(): ResourcePressure | null {
    return this.lastPressure;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  // Resolves when any in-flight run completes. Exposed for tests so they can
  // await the scheduler deterministically instead of polling the filesystem
  // with a fixed timeout.
  async awaitIdle(): Promise<void> {
    if (this.inFlightRun) await this.inFlightRun;
  }
}

// Helper used by Recorder to construct a scheduler from a session + config.
export function summaryOutputPath(session: Session): string {
  // dirname+join (NOT regex) — see spec §2.7 for why.
  return join(dirname(session.outputFile), "summary.md");
}

export function summaryFileExists(session: Session): boolean {
  return existsSync(summaryOutputPath(session));
}

// Post-finalize one-line append. Idempotent — skips if the note is already present.
const FINALIZE_NOTE_MARKER = "Note (post-finalize):";

export async function appendPostFinalizeNote(session: Session): Promise<void> {
  const path = summaryOutputPath(session);
  if (!existsSync(path)) return;
  try {
    const current = await readFile(path, "utf-8");
    if (current.includes(FINALIZE_NOTE_MARKER)) return;
    const note = `\n> ${FINALIZE_NOTE_MARKER} the transcript has been rewritten with Speaker N labels and talk-time. This draft summary still uses Me/Others from the live recording; run \`meet summary --full\` (future) for an updated version.\n`;
    await appendFile(path, note, "utf-8");
  } catch {
    // Fail-open — finalize never blocks on this.
  }
}
