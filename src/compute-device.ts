import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface WhisperComputeInfo {
  // Did the MTL backend actually load on the `--help` invocation? whisper-cli
  // initializes its backends even for `--help`, so this is a free signal that
  // Metal is active on this host without running a real transcription.
  metalActive: boolean;
  // Parsed GPU name line, e.g. "Apple M2 Pro" (extracted from the parens in
  // `GPU name:   MTL0 (Apple M2 Pro)`). null when no Metal device line exists.
  gpuName: string | null;
  // Raw `load_backend:` lines, kept so `meet doctor` can show exactly which
  // backends initialized (BLAS / MTL / CPU).
  backendLines: string[];
}

const EMPTY: WhisperComputeInfo = {
  metalActive: false,
  gpuName: null,
  backendLines: [],
};

// Pure parser — unit-tested against a captured `whisper-cli --help` fixture so
// the brew/host contract is pinned without spawning the binary in CI. Mirrors
// the parseX/readX split used elsewhere (loadavg, diarize JSON, …).
//
// Note: whisper.cpp exposes NO positive `--metal` flag — GPU is on by default
// and the only knobs are `-ng`/`--no-gpu` (disable) and `-dev N`/`--device N`
// (select). So there is nothing to probe for; we report the device only.
export function parseWhisperHelp(stderr: string): WhisperComputeInfo {
  if (!stderr) return { ...EMPTY };

  const lines = stderr.split("\n");
  const backendLines = lines.filter((l) => /^\s*load_backend:/.test(l));

  const metalActive = backendLines.some((l) => /loaded MTL backend/.test(l));

  let gpuName: string | null = null;
  for (const l of lines) {
    const m = l.match(/GPU name:\s*(.*)/);
    if (m) {
      const raw = m[1].trim();
      // Real line looks like `GPU name:   MTL0 (Apple M2 Pro)` — prefer the
      // human-readable chip inside the parens when present.
      const paren = raw.match(/\(([^)]+)\)/);
      gpuName = paren ? paren[1].trim() : raw;
      if (gpuName.length === 0) gpuName = raw || null;
      break;
    }
  }

  return { metalActive, gpuName, backendLines };
}

// Per-binary-path cache: `whisper-cli --help` is stable for a given binary.
let cache: { bin: string; info: WhisperComputeInfo } | null = null;

export function _resetComputeCache(): void {
  cache = null;
}

// Runs `whisper-cli --help` once per binary path and parses the stderr stream
// (this build writes the option list AND the backend-init log to stderr — the
// stdout stream is empty). Fail-open: any error (binary missing, timeout,
// unparseable output) returns the empty info so `meet doctor` reports "unknown"
// rather than crashing. Only consumer is `meet doctor` — never the hot path.
export async function detectWhisperCompute(bin: string): Promise<WhisperComputeInfo> {
  if (cache && cache.bin === bin) return cache.info;
  let stderr = "";
  try {
    // `--help` exits 0 on this brew build; execFileP resolves with { stderr }.
    // Some builds exit non-zero for `--help` but still print help + backend
    // lines to stderr — recover whatever stderr we can either way.
    const out = await execFileP(bin, ["--help"], { timeout: 10_000, maxBuffer: 64 * 1024 });
    stderr = out.stderr ?? "";
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stderr" in err) {
      stderr = String((err as { stderr?: string }).stderr ?? "");
    }
  }
  const info = parseWhisperHelp(stderr);
  cache = { bin, info };
  return info;
}
