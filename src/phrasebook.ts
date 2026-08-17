import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { escapeRegex } from "./regex-utils.js";

export const DEFAULT_PHRASEBOOK_PATH = resolve(import.meta.dirname, "..", "phrasebook.json");

export interface PhrasebookRuleInput {
  from: string;
  to: string;
  caseInsensitive?: boolean;
  wordBoundary?: boolean;
  regex?: boolean;
}

export const RAW_REGEX_SANITY_CAP = 500;

interface PhrasebookFile {
  replacements?: PhrasebookRuleInput[];
}

interface CompiledRule {
  pattern: RegExp;
  to: string;
}

export class Phrasebook {
  private _rules: CompiledRule[];
  private _path: string;
  private _mtime: number | null;

  private constructor(path: string, rules: CompiledRule[], mtime: number | null) {
    this._path = path;
    this._rules = rules;
    this._mtime = mtime;
  }

  static load(path: string, allowRegex = false): Phrasebook {
    const expanded = expandPath(path);
    try {
      const stat = statSync(expanded);
      return Phrasebook._build(expanded, stat.mtimeMs, allowRegex);
    } catch {
      return new Phrasebook(expanded, [], null);
    }
  }

  private static _build(path: string, mtime: number, allowRegex: boolean): Phrasebook {
    let data: PhrasebookFile;
    try {
      const raw = readFileSync(path, "utf-8");
      data = JSON.parse(raw);
    } catch {
      return new Phrasebook(path, [], mtime);
    }

    const rules: CompiledRule[] = [];
    for (const entry of data.replacements ?? []) {
      const src = entry.from;
      const dst = entry.to;
      if (!src || dst === undefined) continue;

      const flags = entry.caseInsensitive ? "gi" : "g";
      let source: string;
      if (entry.regex) {
        // Raw regex runs unsandboxed with no timeout in the sequential live
        // path — a source-length cap alone doesn't stop catastrophic
        // backtracking, so this stays opt-in (phrasebookAllowRegex).
        if (!allowRegex) continue;
        if (src.length >= RAW_REGEX_SANITY_CAP) continue;
        source = src;
      } else {
        source = entry.wordBoundary ? `\\b${escapeRegex(src)}\\b` : escapeRegex(src);
      }
      try {
        const pattern = new RegExp(source, flags);
        if (entry.regex && new RegExp(source).test("")) continue;
        rules.push({ pattern, to: dst });
      } catch {
        continue;
      }
    }

    return new Phrasebook(path, rules, mtime);
  }

  apply(text: string): string {
    let result = text;
    for (const rule of this._rules) {
      result = result.replace(rule.pattern, rule.to);
    }
    return result;
  }

  maybeReload(allowRegex = false): boolean {
    try {
      const stat = statSync(this._path);
      if (this._mtime !== null && stat.mtimeMs === this._mtime) return false;
      const rebuilt = Phrasebook._build(this._path, stat.mtimeMs, allowRegex);
      this._rules = rebuilt._rules;
      this._mtime = rebuilt._mtime;
      return true;
    } catch {
      return false;
    }
  }

  get ruleCount(): number {
    return this._rules.length;
  }
}

function expandPath(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

let _cached: Phrasebook | null = null;
let _cachedPath: string | null = null;

export function getPhrasebook(config: { phrasebookPath?: string; phrasebookReload?: boolean; phrasebookAllowRegex?: boolean }): Phrasebook {
  const path = config.phrasebookPath ?? DEFAULT_PHRASEBOOK_PATH;
  const shouldReload = config.phrasebookReload ?? true;
  const allowRegex = config.phrasebookAllowRegex ?? false;

  if (!_cached || _cachedPath !== path) {
    _cached = Phrasebook.load(path, allowRegex);
    _cachedPath = path;
    return _cached;
  }

  if (shouldReload) {
    _cached.maybeReload(allowRegex);
  }

  return _cached;
}
