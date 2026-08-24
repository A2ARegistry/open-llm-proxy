/**
 * Leveled logger for the Worker. Cloudflare Workers Logs maps
 * console.debug/info/warn/error to severity levels, and log ingestion cost
 * scales with volume, so verbose diagnostics must be gated behind `debug`.
 *
 * Usage:
 *   import { initLogger, log } from "../utils/logger";
 *   initLogger(env);            // once per request / invocation
 *   log.debug("...");           // only emitted when LOG_LEVEL=debug
 *
 * Level is controlled by the `LOG_LEVEL` var (debug | info | warn | error).
 * Unset → `debug` when ENVIRONMENT=development, otherwise `info`.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "info";

export function initLogger(env: {
  LOG_LEVEL?: string;
  ENVIRONMENT?: string;
}): void {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    currentLevel = raw;
    return;
  }
  currentLevel = !raw && env.ENVIRONMENT === "development" ? "debug" : "info";
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function emit(level: LogLevel, args: unknown[]): void {
  if (!enabled(level)) return;
  (level === "debug" ? console.debug : console[level])(...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
