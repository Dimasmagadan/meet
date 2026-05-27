export type CaptureEvent =
  | { level: "info" | "warning" | "error"; event: "capture_started"; mode: string; dir: string; t: number }
  | { level: "info"; event: "chunk_finalized"; source: "mic" | "sys"; filename: string; index: number; t: number }
  | { level: "info" | "warning" | "error"; event: "stream_started"; source: "mic" | "sys"; t: number }
  | { level: "info" | "warning" | "error"; event: "stream_error"; source?: "mic" | "sys"; message: string; t: number }
  | { level: "info"; event: "capture_stopped"; t: number }
  | { level: "info" | "warning" | "error"; event: string; t: number; [key: string]: unknown };

export type ChunkFinalizedEvent = {
  level: "info";
  event: "chunk_finalized";
  source: "mic" | "sys";
  filename: string;
  index: number;
  t: number;
};

function isValidChunkSource(s: unknown): s is "mic" | "sys" {
  return s === "mic" || s === "sys";
}

export function parseCaptureEvent(line: string): CaptureEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null) return null;
    if (typeof obj.event !== "string") return null;
    if (typeof obj.level !== "string") return null;
    if (obj.event === "chunk_finalized" && !isValidChunkSource(obj.source)) return null;
    return obj as CaptureEvent;
  } catch {
    return null;
  }
}

export function parseLegacyChunkFinalized(line: string): { source: "mic" | "sys"; filename: string } | null {
  const match = line.match(/^finalized:\s*(mic|sys)-\d{3}\.wav$/);
  if (!match) return null;
  const filename = line.replace(/^finalized:\s*/, "").trim();
  const source = filename.startsWith("mic") ? "mic" as const : "sys" as const;
  return { source, filename };
}

export function parseCaptureLine(line: string): { type: "json"; event: CaptureEvent } | { type: "legacy"; finalized: { source: "mic" | "sys"; filename: string } } | null {
  const json = parseCaptureEvent(line);
  if (json) return { type: "json", event: json };

  const legacy = parseLegacyChunkFinalized(line);
  if (legacy) return { type: "legacy", finalized: legacy };

  return null;
}
