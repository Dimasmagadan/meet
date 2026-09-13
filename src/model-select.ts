import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expandPath } from "./storage.js";

export const MODELS_DIR = "~/.meet/models";

export interface ModelFileInfo {
  name: string;
  path: string;
  alias: string;
  sizeMb: number;
}

// Short alias for a model file. Order matters: ggml-large-v3-turbo-q5_0.bin
// contains both "large" and "turbo" — turbo is the distinguishing feature.
export function modelAlias(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("turbo")) return "turbo";
  if (lower.includes("large")) return "large";
  if (lower.includes("medium")) return "medium";
  if (lower.includes("small")) return "small";
  if (lower.includes("tiny")) return "tiny";
  return lower.replace(/\.bin$/, "").replace(/^ggml-/, "");
}

export function listModelFiles(dir: string = expandPath(MODELS_DIR)): ModelFileInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".bin"))
    .map((name) => {
      const path = join(dir, name);
      const alias = modelAlias(name);
      const sizeMb = Math.round(statSync(path).size / (1024 * 1024));
      return { name, path, alias, sizeMb };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class ModelNotFoundError extends Error {}

// Resolution order: absolute/~/ path → exact file name (with or without
// .bin) → unique alias → unique substring. Anything ambiguous or missing is
// an error that lists the candidates, never a silent guess.
export function resolveModelInput(input: string, files: ModelFileInfo[]): string {
  const expanded = expandPath(input);
  if (isAbsolute(expanded)) {
    if (existsSync(expanded)) return expanded;
    throw new ModelNotFoundError(`no model file at ${expanded}`);
  }

  const target = input.trim().toLowerCase().replace(/\.bin$/, "");
  const byName = files.filter((f) => f.name.toLowerCase().replace(/\.bin$/, "") === target);
  if (byName.length === 1) return byName[0].path;
  const byAlias = files.filter((f) => f.alias === target);
  if (byAlias.length === 1) return byAlias[0].path;
  const bySubstring = files.filter((f) => f.name.toLowerCase().includes(target));
  if (bySubstring.length === 1) return bySubstring[0].path;

  const candidates = [...byName, ...byAlias, ...bySubstring];
  if (candidates.length > 1) {
    throw new ModelNotFoundError(`"${input}" is ambiguous: ${candidates.map((f) => f.name).join(", ")}`);
  }
  throw new ModelNotFoundError(
    `no model matches "${input}" — available: ${files.map((f) => f.alias).join(", ") || "(none)"}`
  );
}

// Config values conventionally store ~ paths (portable if the account home
// moves); this is the inverse of expandPath for paths under homedir.
export function contractHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
