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

    // P3 (SPEC_SAFETY_NET_2026-10-31 §7 row 1): same-index mic+sys must land
    // mic-first — the live path and entriesFromSession put "Me" before the
    // sys chunk at equal timestamps, and the old sys-first push here made
    // the final rewrite flip that order. Mic decisions run first; both rows
    // are appended below in mic-first order.
    let micKept = false;

    if (mic && mic.text) {
      // Same accumulator as the echo/duplicate drops below: the finalize safety
      // net (finalize.ts) compares the final-pass entry count against base
      // entries excluding recorded drops, so an unrecorded drop here makes it
      // see a shrunk final pass and restore this silent chunk.
      if (mic.rmsDb < config.micRmsThresholdDb) {
        droppedEcho?.push(mic);
      } else {
        // P2-3 (SPEC_SAFETY_NET_2026-10-31 §4.3): the audio-only echo score is
        // envelope correlation against sys AUDIO — whisper transcribing that sys
        // audio as nothing (music, HVAC) means there is no echo'd SPEECH to
        // duplicate, so dropping the mic entry deleted the user's only copy.
        // The drop additionally requires a sys text counterpart at the same
        // index or N±1 (mirrors mic-echo.ts's hasSysCounterpart neighbourhood).
        const hasSysTextNeighbour = (n: number): boolean =>
          [n - 1, n, n + 1].some((i) => (sysTokensByIndex.get(i)?.length ?? 0) > 0);
        const sameSys = sys && sys.text ? sys : null;

        if (mic.micEchoScore !== undefined && mic.micEchoScore >= echoFractionThreshold && hasSysTextNeighbour(idx)) {
          droppedEcho?.push(mic);
        } else if (sameSys && isDuplicate(mic.text, sameSys.text)) {
          droppedEcho?.push(mic);
        } else {
          const neighbourhood = new Set<string>();
          for (const n of [idx - 1, idx, idx + 1]) {
            const tokens = sysTokensByIndex.get(n);
            if (tokens) for (const t of tokens) neighbourhood.add(t);
          }
          if (neighbourhood.size > 0 && coverageRatio(tokenize(mic.text), neighbourhood) >= coverageThreshold) {
            droppedEcho?.push(mic);
          } else if (sameSys && isAcknowledgement(mic.text)) {
            // Duplicates and acknowledgements are the same class as echo drops —
            // a mic "ага" over sys speech is bleed — so they go into the same
            // accumulator. The finalize safety net compares final-pass entry
            // count against base entries excluding recorded drops; bare drops
            // here made it see a shrunk final pass and revert the whole thing.
            droppedEcho?.push(mic);
          } else {
            micKept = true;
          }
        }
      }
    }

    if (micKept) kept.push(mic!);
    if (sys && sys.text) kept.push(sys);
  }

  return kept;
}

export { normalizeForComparison, tokenize, jaccardSimilarity, isDuplicate, isAcknowledgement, coverageRatio };
