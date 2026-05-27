export interface FinalChunkResult {
  source: "mic" | "sys";
  index: number;
  wav: string;
  text: string;
  rmsDb: number;
  peakDb: number;
}

const ACKNOWLEDGEMENTS = new Set([
  "да", "ага", "угу", "ок", "окей", "понятно", "хорошо", "супер",
  "ясно", "спасибо", "ага", "мм", "м", "ну", "так", "внешем",
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

function isAcknowledgement(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length === 0) return false;
  if (tokens.length > 3) return false;
  return tokens.every((t) => ACKNOWLEDGEMENTS.has(t));
}

export interface FilterConfig {
  micRmsThresholdDb: number;
}

export function filterEntries(
  results: FinalChunkResult[],
  config: FilterConfig
): FinalChunkResult[] {
  const byIndex = new Map<number, FinalChunkResult[]>();
  for (const r of results) {
    const list = byIndex.get(r.index) || [];
    list.push(r);
    byIndex.set(r.index, list);
  }

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

    if (sys && sys.text && isDuplicate(mic.text, sys.text)) continue;

    if (sys && sys.text && isAcknowledgement(mic.text)) continue;

    if (sys && sys.text) {
      const micTokens = tokenize(mic.text);
      if (micTokens.length <= 3) continue;
    }

    kept.push(mic);
  }

  return kept;
}

export { normalizeForComparison, tokenize, jaccardSimilarity, isDuplicate, isAcknowledgement };
