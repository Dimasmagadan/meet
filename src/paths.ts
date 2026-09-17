import { homedir } from "node:os";

// Deliberately dependency-free: vocabulary/phrasebook/triggers sit on the
// far side of an import cycle (types.ts → triggers.ts, storage.ts → types.ts),
// so importing storage.ts's copy of this from there would make module init
// order load-bearing. storage.ts re-exports it for the rest of the app.
export function expandPath(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}
