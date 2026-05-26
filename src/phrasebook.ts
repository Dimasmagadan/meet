import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

export interface PhrasebookRuleInput {
  from: string;
  to: string;
  caseInsensitive?: boolean;
  wordBoundary?: boolean;
}

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

  static load(path: string): Phrasebook {
    const expanded = expandPath(path);
    try {
      const stat = statSync(expanded);
      return Phrasebook._build(expanded, stat.mtimeMs);
    } catch {
      return new Phrasebook(expanded, [], null);
    }
  }

  private static _build(path: string, mtime: number): Phrasebook {
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
      const source = entry.wordBoundary ? `\\b${escapeRegex(src)}\\b` : escapeRegex(src);
      try {
        rules.push({ pattern: new RegExp(source, flags), to: dst });
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

  maybeReload(): boolean {
    try {
      const stat = statSync(this._path);
      if (this._mtime !== null && stat.mtimeMs === this._mtime) return false;
      const rebuilt = Phrasebook._build(this._path, stat.mtimeMs);
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandPath(p: string): string {
  return p.startsWith("~") ? p.replace("~", homedir()) : p;
}

let _cached: Phrasebook | null = null;
let _cachedPath: string | null = null;

export function getPhrasebook(config: { phrasebookPath?: string; phrasebookReload?: boolean }): Phrasebook {
  const path = config.phrasebookPath ?? "~/.meet/phrasebook.json";
  const shouldReload = config.phrasebookReload ?? true;

  if (!_cached || _cachedPath !== path) {
    _cached = Phrasebook.load(path);
    _cachedPath = path;
    return _cached;
  }

  if (shouldReload) {
    _cached.maybeReload();
  }

  return _cached;
}
