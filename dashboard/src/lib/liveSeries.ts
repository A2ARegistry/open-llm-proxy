// [fork] W11: turns /api/live snapshots into chart points. CPU use comes from
// counter deltas between two snapshots; a counter that went down (server
// restart) or no elapsed time gives a gap (null), never a negative value.
// Token throughput is not derived here: the box's token counters only move
// when a request finishes, so deltas draw one spike per request. It comes
// from the request log (`snapshot.throughput`).
import type { LiveSnapshot } from "./api";
import { ramBreakdown } from "./ramBreakdown";

export const LIVE_POLL_MS = 2000;
export const LIVE_HISTORY_POINTS = 300;
/** Longest interval still turned into a rate (2.5 polls). */
export const LIVE_GAP_MS = 5000;
/**
 * How often the Live view rereads the stored samples of its window, so
 * stretches it did not poll (hidden tab, failed requests) fill in. The
 * sampler writes to D1 about once a minute.
 */
export const LIVE_SEED_REFRESH_MS = 60_000;

export interface LivePoint {
  t: number;
  /** Requests waiting for a slot. */
  queued: number | null;
  /** KV pool in use, 0-100. */
  kvPct: number | null;
  /** Prompt cache hits / lookups since the previous sample, 0-100. */
  cacheHitPct: number | null;
  /** Accepted / drafted tokens since the previous sample, 0-100. */
  draftPct: number | null;
  cpuPercent: number | null;
  /** RAM in use including mapped model files, 0-100. */
  ramPct: number | null;
  gpuBusyPercent: number | null;
  gpuMemPct: number | null;
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

/** `num / den`, or null when either is missing or `den` is 0. */
export function ratio(num: number | null, den: number | null): number | null {
  if (num == null || den == null || den === 0) return null;
  return num / den;
}

/** `ratio` as a 0-100 value. */
export function percentOf(
  part: number | null | undefined,
  whole: number | null | undefined,
): number | null {
  const r = ratio(part ?? null, whole ?? null);
  return r === null ? null : r * 100;
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
  const host = next.host;
  const prevHost = prev?.host;
  const inf = next.inference;
  const prevInf = prev?.inference;

  const hostSeconds = interval(prevHost, host);
  const idle = delta(prevHost?.cpuIdleSecondsTotal, host?.cpuIdleSecondsTotal);
  const total = delta(prevHost?.cpuSecondsTotal, host?.cpuSecondsTotal);
  const idleShare = hostSeconds > 0 ? ratio(idle, total) : null;

  // Same per-interval ratios as the stored rows (src/live/sample-row.ts):
  // no lookups or drafts in the interval gives a gap, not 0%.
  const infRated = interval(prevInf, inf) > 0;
  const hits = delta(prevInf?.cacheHitsTotal, inf?.cacheHitsTotal);
  const misses = delta(prevInf?.cacheMissesTotal, inf?.cacheMissesTotal);
  const drafted = delta(prevInf?.draftTokensTotal, inf?.draftTokensTotal);
  const accepted = delta(prevInf?.draftAcceptedTotal, inf?.draftAcceptedTotal);

  return {
    t: next.at,
    queued: inf?.queued ?? null,
    kvPct: inf?.kvUsageRatio == null ? null : inf.kvUsageRatio * 100,
    cacheHitPct:
      infRated && hits !== null && misses !== null
        ? percentOf(hits, hits + misses)
        : null,
    draftPct: infRated ? percentOf(accepted, drafted) : null,
    cpuPercent: idleShare === null ? null : 100 * (1 - idleShare),
    ramPct: host ? (ramBreakdown(host)?.inUsePercent ?? null) : null,
    gpuBusyPercent: host?.gpuBusyPercent ?? null,
    gpuMemPct: percentOf(host?.gpuMemUsedBytes, host?.gpuMemTotalBytes),
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
