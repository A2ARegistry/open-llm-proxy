// [fork] W11: turns /api/live snapshots into chart points. Rates come from
// counter deltas between two snapshots; a counter that went down (server
// restart) or no elapsed time gives a gap (null), never a negative value.
import type { LiveSnapshot } from "./api";

export const LIVE_POLL_MS = 2000;
export const LIVE_HISTORY_POINTS = 300;

export interface LivePoint {
  t: number;
  decodeTps: number | null;
  prefillTps: number | null;
  cpuPercent: number | null;
  gpuBusyPercent: number | null;
  cpuTempC: number | null;
  gpuTempC: number | null;
  ssdTempC: number | null;
  gpuPowerW: number | null;
}

function delta(
  prev: number | null | undefined,
  next: number | null | undefined,
): number | null {
  if (prev == null || next == null || next < prev) return null;
  return next - prev;
}

function perSecond(
  prev: number | null | undefined,
  next: number | null | undefined,
  seconds: number,
): number | null {
  const d = delta(prev, next);
  return d === null || seconds <= 0 ? null : d / seconds;
}

/** `num / den`, or null when either is missing or `den` is 0. */
export function ratio(num: number | null, den: number | null): number | null {
  if (num == null || den == null || den === 0) return null;
  return num / den;
}

/** One chart point from the latest snapshot, using `prev` for rates. */
export function toPoint(
  prev: LiveSnapshot | null,
  next: LiveSnapshot,
): LivePoint {
  const seconds = prev ? (next.at - prev.at) / 1000 : 0;
  const inf = next.inference;
  const prevInf = prev?.inference;
  const host = next.host;
  const prevHost = prev?.host;

  const idle = delta(prevHost?.cpuIdleSecondsTotal, host?.cpuIdleSecondsTotal);
  const total = delta(prevHost?.cpuSecondsTotal, host?.cpuSecondsTotal);
  const idleShare = ratio(idle, total);

  return {
    t: next.at,
    decodeTps: perSecond(
      prevInf?.predictedTokensTotal,
      inf?.predictedTokensTotal,
      seconds,
    ),
    prefillTps: perSecond(
      prevInf?.promptTokensTotal,
      inf?.promptTokensTotal,
      seconds,
    ),
    cpuPercent: idleShare === null ? null : 100 * (1 - idleShare),
    gpuBusyPercent: host?.gpuBusyPercent ?? null,
    cpuTempC: host?.cpuTempC ?? null,
    gpuTempC: host?.gpuTempC ?? null,
    ssdTempC: host?.ssdTempC ?? null,
    gpuPowerW: host?.gpuPowerW ?? null,
  };
}

/** Append `point`, keeping only the last LIVE_HISTORY_POINTS. */
export function appendPoint(
  points: LivePoint[],
  point: LivePoint,
): LivePoint[] {
  const next = [...points, point];
  return next.length > LIVE_HISTORY_POINTS
    ? next.slice(next.length - LIVE_HISTORY_POINTS)
    : next;
}
