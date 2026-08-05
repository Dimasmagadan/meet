import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const DEFAULT_VOCABULARY_PATH = resolve(import.meta.dirname, "..", "vocabulary.json");

interface VocabularyFile {
  terms?: unknown[];
}

const DEFAULT_MAX_TOTAL_CHARS = 200;
const SUFFIX_PREFIX = ". Термины: ";
const TERM_SEPARATOR = ", ";

export class Vocabulary {
  private _terms: string[];
  private _path: string;
  private _mtime: number | null;

  private constructor(path: string, terms: string[], mtime: number | null) {
    this._path = path;
    this._terms = terms;
    this._mtime = mtime;
  }

  static load(path: string): Vocabulary {
    const expanded = expandPath(path);
    try {
      const stat = statSync(expanded);
      return Vocabulary._build(expanded, stat.mtimeMs);
    } catch {
      return new Vocabulary(expanded, [], null);
    }
  }

  private static _build(path: string, mtime: number): Vocabulary {
    let data: VocabularyFile;
    try {
      const raw = readFileSync(path, "utf-8");
      data = JSON.parse(raw);
    } catch {
      return new Vocabulary(path, [], mtime);
    }

    const terms: string[] = [];
    for (const entry of data.terms ?? []) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed) continue;
      terms.push(trimmed);
    }

    return new Vocabulary(path, terms, mtime);
  }

  get terms(): string[] {
    return [...this._terms];
  }

  get termCount(): number {
    return this._terms.length;
  }

  // extraTerms (e.g. calendar attendee names, SPEC_CALENDAR_AUTOSTART §6.2) share the same
  // char budget as file-based terms and are sized after them, so a long phrasebook never
  // gets silently starved by a long attendee list.
  toPromptSuffix(basePrompt: string, maxTotalChars: number = DEFAULT_MAX_TOTAL_CHARS, extraTerms: string[] = []): string {
    const allTerms = [...this._terms, ...extraTerms];
    if (allTerms.length === 0) return "";
    if (basePrompt.length >= maxTotalChars) return "";

    const budget = maxTotalChars - basePrompt.length;
    if (budget < SUFFIX_PREFIX.length) return "";

    let remaining = budget - SUFFIX_PREFIX.length;
    const parts: string[] = [];
    for (const term of allTerms) {
      const sep = parts.length === 0 ? "" : TERM_SEPARATOR;
      const added = sep.length + term.length;
      if (added > remaining) break;
      remaining -= added;
      parts.push(term);
    }

    if (parts.length === 0) return "";
    return SUFFIX_PREFIX + parts.join(TERM_SEPARATOR);
  }

  maybeReload(): boolean {
    try {
      const stat = statSync(this._path);
      if (this._mtime !== null && stat.mtimeMs === this._mtime) return false;
      const rebuilt = Vocabulary._build(this._path, stat.mtimeMs);
      this._terms = rebuilt._terms;
      this._mtime = rebuilt._mtime;
      return true;
    } catch {
      return false;
    }
  }
}

function expandPath(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

let _cached: Vocabulary | null = null;
let _cachedPath: string | null = null;

export function getVocabulary(config: { vocabularyPath?: string; vocabularyReload?: boolean }): Vocabulary {
  const path = config.vocabularyPath ?? DEFAULT_VOCABULARY_PATH;
  const shouldReload = config.vocabularyReload ?? true;

  if (!_cached || _cachedPath !== path) {
    _cached = Vocabulary.load(path);
    _cachedPath = path;
    return _cached;
  }

  if (shouldReload) {
    _cached.maybeReload();
  }

  return _cached;
}
