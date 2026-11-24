// [fork] W11: turns /api/live snapshots into chart points. Rates come from
// counter deltas between two snapshots; a counter that went down (server
// restart) or no elapsed time gives a gap (null), never a negative value.
import type { LiveSnapshot } from "./api";

export const LIVE_POLL_MS = 2000;
export const LIVE_HISTORY_POINTS = 300;
/** Longest interval still turned into a rate (2.5 polls). */
export const LIVE_GAP_MS = 5000;

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

/**
 * Seconds between two samples of the same source, or 0 (no rate) when either
 * is missing or the gap is longer than LIVE_GAP_MS (hidden tab, failed polls):
 * averaging over a long gap would draw a fake point next to old data.
 */
function interval(
  prev: { sampledAt: number } | null | undefined,
  next: { sampledAt: number } | null | undefined,
): number {
  if (!prev || !next) return 0;
  const ms = next.sampledAt - prev.sampledAt;
  return ms > 0 && ms <= LIVE_GAP_MS ? ms / 1000 : 0;
}

/** One chart point from the latest snapshot, using `prev` for rates. */
export function toPoint(
  prev: LiveSnapshot | null,
  next: LiveSnapshot,
): LivePoint {
  const inf = next.inference;
  const prevInf = prev?.inference;
  const host = next.host;
  const prevHost = prev?.host;
  const infSeconds = interval(prevInf, inf);

  const hostSeconds = interval(prevHost, host);
  const idle = delta(prevHost?.cpuIdleSecondsTotal, host?.cpuIdleSecondsTotal);
  const total = delta(prevHost?.cpuSecondsTotal, host?.cpuSecondsTotal);
  const idleShare = hostSeconds > 0 ? ratio(idle, total) : null;

  return {
    t: next.at,
    decodeTps: perSecond(
      prevInf?.predictedTokensTotal,
      inf?.predictedTokensTotal,
      infSeconds,
    ),
    prefillTps: perSecond(
      prevInf?.promptTokensTotal,
      inf?.promptTokensTotal,
      infSeconds,
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

export interface LiveSeriesState {
  prev: LiveSnapshot | null;
  points: LivePoint[];
}

/**
 * Pure state step for the Live page: add a point for `snapshot` (rates from
 * the previous one) and make it the new previous. A snapshot already seen
 * returns the same state object.
 */
export function advanceLive(
  state: LiveSeriesState,
  snapshot: LiveSnapshot,
): LiveSeriesState {
  if (state.prev?.at === snapshot.at) return state;
  return {
    prev: snapshot,
    points: appendPoint(state.points, toPoint(state.prev, snapshot)),
  };
}
