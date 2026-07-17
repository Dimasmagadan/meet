import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

export interface TriggerMatch {
  trigger: string;
  snippet: string;
}

interface TriggersFile {
  triggers?: unknown[];
}

interface CompiledTrigger {
  original: string;
  lower: string;
}

const SNIPPET_RADIUS = 40;

export class Triggers {
  private _triggers: CompiledTrigger[];
  private _path: string;
  private _mtime: number | null;

  private constructor(path: string, triggers: CompiledTrigger[], mtime: number | null) {
    this._path = path;
    this._triggers = triggers;
    this._mtime = mtime;
  }

  static load(path: string): Triggers {
    const expanded = expandPath(path);
    try {
      const stat = statSync(expanded);
      return Triggers._build(expanded, stat.mtimeMs);
    } catch {
      return new Triggers(expanded, [], null);
    }
  }

  private static _build(path: string, mtime: number): Triggers {
    let data: TriggersFile;
    try {
      const raw = readFileSync(path, "utf-8");
      data = JSON.parse(raw);
    } catch {
      return new Triggers(path, [], mtime);
    }

    const triggers: CompiledTrigger[] = [];
    for (const entry of data.triggers ?? []) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      triggers.push({ original: entry, lower: entry.toLowerCase() });
    }

    return new Triggers(path, triggers, mtime);
  }

  match(text: string): TriggerMatch | null {
    const lower = text.toLowerCase();
    for (const trigger of this._triggers) {
      const idx = lower.indexOf(trigger.lower);
      if (idx === -1) continue;
      return {
        trigger: trigger.original,
        snippet: buildSnippet(text, idx, trigger.lower.length),
      };
    }
    return null;
  }

  maybeReload(): boolean {
    try {
      const stat = statSync(this._path);
      if (this._mtime !== null && stat.mtimeMs === this._mtime) return false;
      const rebuilt = Triggers._build(this._path, stat.mtimeMs);
      this._triggers = rebuilt._triggers;
      this._mtime = rebuilt._mtime;
      return true;
    } catch {
      return false;
    }
  }

  get triggerCount(): number {
    return this._triggers.length;
  }
}

function buildSnippet(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIndex + matchLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function expandPath(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

let _cached: Triggers | null = null;
let _cachedPath: string | null = null;

export function getTriggers(config: { triggersPath?: string; triggersReload?: boolean }): Triggers {
  const path = config.triggersPath ?? "~/.meet/triggers.json";
  const shouldReload = config.triggersReload ?? true;

  if (!_cached || _cachedPath !== path) {
    _cached = Triggers.load(path);
    _cachedPath = path;
    return _cached;
  }

  if (shouldReload) {
    _cached.maybeReload();
  }

  return _cached;
}
