import { DEFAULT_CONFIG, type Config, type Session } from "./types.js";

export interface AutoStopState {
  elapsedSec: number;
  noTextGapSec: number;
  queueLagChunks: number;
  autoExtendCount: number;
  manualCapOverride: boolean;
  hardCapWarningSent: boolean;
}

export interface AutoStopOptions {
  maxDurationMinutes: number;
  noTextTimeoutMinutes: number;
  calendarHardCapMinutes?: number;
}

export type AutoStopDecision =
  | { kind: "stop"; reason: NonNullable<Session["autoStopReason"]> }
  | { kind: "continue"; extension?: { newMaxDurationMinutes: number; cause: "activity" | "queue_lag" }; warning?: { minutesLeft: number } };

export function calendarCapConfig(config: Config): Pick<Config,
  "calendarCapAutoExtend" | "calendarCapAutoExtendStepMinutes" |
  "calendarCapAutoExtendActivityWindowMinutes" | "calendarCapAutoExtendMaxLagChunks" |
  "calendarCapWarningLeadMinutes"> {
  const defaults = DEFAULT_CONFIG;
  const positive = (value: number, fallback: number) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return {
    calendarCapAutoExtend: typeof config.calendarCapAutoExtend === "boolean" ? config.calendarCapAutoExtend : defaults.calendarCapAutoExtend,
    calendarCapAutoExtendStepMinutes: positive(config.calendarCapAutoExtendStepMinutes, defaults.calendarCapAutoExtendStepMinutes),
    calendarCapAutoExtendActivityWindowMinutes: positive(config.calendarCapAutoExtendActivityWindowMinutes, defaults.calendarCapAutoExtendActivityWindowMinutes),
    calendarCapAutoExtendMaxLagChunks: Number.isSafeInteger(config.calendarCapAutoExtendMaxLagChunks) && config.calendarCapAutoExtendMaxLagChunks >= 0
      ? config.calendarCapAutoExtendMaxLagChunks : defaults.calendarCapAutoExtendMaxLagChunks,
    calendarCapWarningLeadMinutes: positive(config.calendarCapWarningLeadMinutes, defaults.calendarCapWarningLeadMinutes),
  };
}

export function decideAutoStop(state: AutoStopState, opts: AutoStopOptions, cfg: ReturnType<typeof calendarCapConfig>): AutoStopDecision {
  const hardCap = opts.calendarHardCapMinutes;
  const adaptive = cfg.calendarCapAutoExtend && !state.manualCapOverride && hardCap !== undefined;
  if (adaptive && state.elapsedSec >= hardCap * 60) return { kind: "stop", reason: "calendar_hard_cap" };

  let extension: Extract<AutoStopDecision, { kind: "continue" }>["extension"];
  if (opts.maxDurationMinutes > 0 && state.elapsedSec >= opts.maxDurationMinutes * 60) {
    if (!adaptive) return { kind: "stop", reason: "max_duration" };
    const lagged = state.queueLagChunks > cfg.calendarCapAutoExtendMaxLagChunks;
    const active = state.noTextGapSec < cfg.calendarCapAutoExtendActivityWindowMinutes * 60;
    if (!lagged && !active) return { kind: "stop", reason: "max_duration" };
    extension = {
      // P3 (§7 row 3): whole-minute caps — fractional values fed formatClock's
      // raw "sec % 60" and produced garbage clock output downstream.
      newMaxDurationMinutes: Math.ceil(Math.min(hardCap, state.elapsedSec / 60 + cfg.calendarCapAutoExtendStepMinutes)),
      cause: lagged ? "queue_lag" : "activity",
    };
  }

  if (opts.noTextTimeoutMinutes > 0 && state.noTextGapSec >= opts.noTextTimeoutMinutes * 60) {
    return { kind: "stop", reason: "no_text_timeout" };
  }

  const result: Extract<AutoStopDecision, { kind: "continue" }> = { kind: "continue" };
  if (extension) result.extension = extension;
  if (adaptive && !state.hardCapWarningSent && state.autoExtendCount + (extension ? 1 : 0) > 0 &&
      state.elapsedSec >= hardCap * 60 - cfg.calendarCapWarningLeadMinutes * 60) {
    result.warning = { minutesLeft: Math.ceil((hardCap * 60 - state.elapsedSec) / 60) };
  }
  return result;
}
