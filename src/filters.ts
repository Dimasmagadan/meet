export interface FinalChunkResult {
  source: "mic" | "sys";
  index: number;
  wav: string;
  text: string;
  rmsDb: number;
  peakDb: number;
  // P2: echoFraction at the best-correlated lag against the sys neighbourhood,
  // set only when the correlation already cleared micEchoCorrelationThreshold
  // (final-pass.ts). Undefined means "not computed / not correlated enough".
  micEchoScore?: number;
}

const ACKNOWLEDGEMENTS = new Set([
  "да", "ага", "угу", "ок", "окей", "понятно", "хорошо", "супер",
  "ясно", "спасибо", "мм", "м", "ну", "так", "внешем",
]);

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:…—–\-"']/g, "")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeForComparison(text).split(/\s+/).filter(Boolean);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

function isDuplicate(micText: string, sysText: string): boolean {
  const normMic = normalizeForComparison(micText);
  const normSys = normalizeForComparison(sysText);

  if (normMic === normSys) return true;

  if (normMic.length > 10 && normSys.length > 10) {
    if (normSys.includes(normMic) || normMic.includes(normSys)) return true;
  }

  const tokensMic = tokenize(micText);
  const tokensSys = tokenize(sysText);
  const sim = jaccardSimilarity(tokensMic, tokensSys);
  if (sim >= 0.75 && tokensMic.length >= 3) return true;

  return false;
}

// Asymmetric coverage: "is everything the mic heard already present in what
// the speakers played?" Unlike symmetric Jaccard, a sys side that legitimately
// contains more material (near-end-only speech, a ±1-chunk neighbourhood)
// doesn't drag the score down — the sys side is allowed to be a superset.
function coverageRatio(micTokens: string[], sysTokens: Set<string>): number {
  const micSet = new Set(micTokens);
  if (micSet.size === 0) return 0;
  let hit = 0;
  for (const t of micSet) {
    if (sysTokens.has(t)) hit++;
  }
  return hit / micSet.size;
}

function isAcknowledgement(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length === 0) return false;
  if (tokens.length > 3) return false;
  return tokens.every((t) => ACKNOWLEDGEMENTS.has(t));
}

export interface FilterConfig {
  micRmsThresholdDb: number;
  // P1: mic tokens covered by the sys {N-1,N,N+1} neighbourhood at or above
  // this fraction are dropped as echo (asymmetric coverage, not Jaccard).
  micEchoCoverageThreshold?: number;
  // P2: mic.micEchoScore (echoFraction at the best-correlated lag) at or
  // above this fraction is dropped as echo. Only set when final-pass.ts's
  // correlation gate (micEchoCorrelationThreshold) already passed.
  micEchoFractionThreshold?: number;
}

const DEFAULT_COVERAGE_THRESHOLD = 0.75;
const DEFAULT_ECHO_FRACTION_THRESHOLD = 0.9;

export function filterEntries(
  results: FinalChunkResult[],
  config: FilterConfig,
  droppedEcho?: FinalChunkResult[]
): FinalChunkResult[] {
  const byIndex = new Map<number, FinalChunkResult[]>();
  for (const r of results) {
    const list = byIndex.get(r.index) || [];
    list.push(r);
    byIndex.set(r.index, list);
  }

  const sysTokensByIndex = new Map<number, string[]>();
  for (const [idx, chunks] of byIndex) {
    const sys = chunks.find((c) => c.source === "sys");
    if (sys && sys.text) sysTokensByIndex.set(idx, tokenize(sys.text));
  }

  const coverageThreshold = config.micEchoCoverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;
  const echoFractionThreshold = config.micEchoFractionThreshold ?? DEFAULT_ECHO_FRACTION_THRESHOLD;

  const kept: FinalChunkResult[] = [];

  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  for (const idx of indices) {
    const chunks = byIndex.get(idx) || [];
    const mic = chunks.find((c) => c.source === "mic");
    const sys = chunks.find((c) => c.source === "sys");

    if (sys && sys.text) {
      kept.push(sys);
    }

    if (!mic || !mic.text) continue;

    if (mic.rmsDb < config.micRmsThresholdDb) continue;

    if (mic.micEchoScore !== undefined && mic.micEchoScore >= echoFractionThreshold) {
      droppedEcho?.push(mic);
      continue;
    }

    // isDuplicate needs the same-index sys chunk itself; the coverage check
    // below doesn't (chunk boundaries aren't utterance-aligned, so a mic
    // echo's sys counterpart often lands in N±1 — mic-echo.ts'
    // hasSysCounterpart runs the same neighbourhood check with no same-index
    // requirement). Gating the whole block on sys[N] text made that gate
    // unreachable whenever the counterpart sat in an adjacent chunk.
    const sameSys = sys && sys.text ? sys : null;

    if (sameSys && isDuplicate(mic.text, sameSys.text)) {
      droppedEcho?.push(mic);
      continue;
    }

    const neighbourhood = new Set<string>();
    for (const n of [idx - 1, idx, idx + 1]) {
      const tokens = sysTokensByIndex.get(n);
      if (tokens) for (const t of tokens) neighbourhood.add(t);
    }
    if (neighbourhood.size > 0) {
      const micTokens = tokenize(mic.text);
      if (coverageRatio(micTokens, neighbourhood) >= coverageThreshold) {
        droppedEcho?.push(mic);
        continue;
      }
    }

    // Duplicates and acknowledgements are the same class as echo drops — a
    // mic "ага" over sys speech is bleed — so they go into the same
    // accumulator. The finalize safety net compares final-pass entry count
    // against base entries excluding recorded drops; bare `continue`s here
    // made it see a shrunk final pass and revert the whole thing.
    if (sameSys && isAcknowledgement(mic.text)) {
      droppedEcho?.push(mic);
      continue;
    }

    kept.push(mic);
  }

  return kept;
}

export { normalizeForComparison, tokenize, jaccardSimilarity, isDuplicate, isAcknowledgement, coverageRatio };
