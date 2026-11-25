// [fork] W12: pure helpers behind the Live page charts and range picker.
import type { LiveHistory, ThroughputPoint } from "./api";
import { pct } from "./format";
import { LIVE_RANGES } from "./liveHistory";
import { LIVE_GAP_MS, LIVE_HISTORY_POINTS, LIVE_POLL_MS } from "./liveSeries";
import type { RangePreset } from "./timeRange";

export type LiveRange = RangePreset | "live";

export function isLiveRange(range: LiveRange): range is "live" {
  return range === "live";
}

/** `raw` if the Live page offers it, else "live" (the default). */
export function parseLiveRange(raw: string | null): LiveRange {
  return raw !== null && (LIVE_RANGES as readonly string[]).includes(raw)
    ? (raw as LiveRange)
    : "live";
}

/** An all-null point halfway between `prev` and `next`: a line break. */
function breakBetween<T extends { t: number }>(prev: T, next: T): T {
  return Object.fromEntries(
    Object.keys(prev).map((k) => [k, k === "t" ? (prev.t + next.t) / 2 : null]),
  ) as T;
}

/**
 * Insert an all-null point between consecutive points further apart than
 * `gapMs`, so a line chart shows a break (paused tab, outage) instead of a
 * straight line across it.
 */
export function withGaps<T extends { t: number }>(
  points: T[],
  gapMs: number,
): T[] {
  const out: T[] = [];
  points.forEach((point, i) => {
    const prev = points[i - 1];
    if (prev && point.t - prev.t > gapMs) out.push(breakBetween(prev, point));
    out.push(point);
  });
  return out;
}

/** "10 s", "10 min", "2 h": the resolution of a stored bucket. */
export function bucketLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${seconds / 60} min`;
  const hours = seconds / 3600;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Axis label for a timestamp on a chart spanning `spanMs`. */
export function axisTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= 15 * MINUTE_MS)
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (spanMs <= DAY_MS) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return spanMs <= 14 * DAY_MS ? `${date}, ${time}` : date;
}

/** Stored samples are 10 s apart; a longer step between them is a gap. */
const SEED_GAP_MS = 15_000;

/** [first, last] ms of each run of polls no more than LIVE_GAP_MS apart. */
function pollRuns(points: { t: number }[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const { t } of points) {
    const last = runs[runs.length - 1];
    if (last && t - last[1] <= LIVE_GAP_MS) last[1] = t;
    else runs.push([t, t]);
  }
  return runs;
}

/**
 * Live chart points: the polled points, with stored 10 s samples (`seed`,
 * from GET /api/live/history, already gap-filled per bucket) wherever no
 * polls cover the time since `windowStart`: before the first poll, and in
 * stretches the browser did not poll (hidden tab, failed requests). The
 * sampler writes whether or not the page is open, so a refetched seed fills
 * those stretches. A line breaks where two polls are more than LIVE_GAP_MS
 * apart, or any other neighbours more than SEED_GAP_MS apart (stored rows
 * reach D1 up to ~1 min late, so the newest stretch fills on a later fetch).
 */
export function seededLivePoints<T extends { t: number }>(
  seed: T[],
  points: T[],
  windowStart: number,
): T[] {
  const runs = pollRuns(points);
  const stored = seed.filter(
    (p) =>
      p.t >= windowStart &&
      !runs.some(([from, to]) => p.t >= from && p.t <= to),
  );
  const merged = [
    ...stored.map((point) => ({ point, polled: false })),
    ...points.map((point) => ({ point, polled: true })),
  ].sort((a, b) => a.point.t - b.point.t);
  const out: T[] = [];
  merged.forEach((cur, i) => {
    const prev = merged[i - 1];
    const gapMs = prev?.polled && cur.polled ? LIVE_GAP_MS : SEED_GAP_MS;
    if (prev && cur.point.t - prev.point.t > gapMs)
      out.push(breakBetween(prev.point, cur.point));
    out.push(cur.point);
  });
  return out;
}

/** [from, to] ms of the Live view's browser history, ending at `atMs`. */
export function liveWindow(atMs: number): [number, number] {
  return [atMs - LIVE_HISTORY_POINTS * LIVE_POLL_MS, atMs];
}

export interface ThroughputChartPoint {
  t: number;
  decodeTps: number | null;
  prefillTps: number | null;
}

/** Server throughput buckets (unix seconds) as chart points (ms). */
export function throughputPoints(
  points: ThroughputPoint[],
): ThroughputChartPoint[] {
  return points.map((p) => ({
    t: p.ts * 1000,
    decodeTps: p.decodeTps,
    prefillTps: p.prefillTps,
  }));
}

export interface ThroughputStats {
  decodeNow: number | null;
  prefillNow: number | null;
  decodePeak: number | null;
  prefillPeak: number | null;
}

/** Complete 10 s buckets averaged into the headline rate (1 minute). */
export const THROUGHPUT_NOW_BUCKETS = 6;

/**
 * Headline and peak decode / prefill rate of a throughput series. The last
 * bucket is still filling (the window ends at the next 10 s boundary), so the
 * headline is the mean of the `THROUGHPUT_NOW_BUCKETS` complete buckets before
 * it: a single 10 s bucket is almost always empty, since a request only
 * shows up once it has finished.
 */
export function throughputStats(points: ThroughputPoint[]): ThroughputStats {
  const complete = points.length >= 2 ? points.slice(0, -1) : points;
  const recent = complete.slice(-THROUGHPUT_NOW_BUCKETS);
  const mean = (values: number[]) =>
    values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  return {
    decodeNow: mean(recent.map((p) => p.decodeTps)),
    prefillNow: mean(recent.map((p) => p.prefillTps)),
    decodePeak: points.length
      ? Math.max(...points.map((p) => p.decodeTps))
      : null,
    prefillPeak: points.length
      ? Math.max(...points.map((p) => p.prefillTps))
      : null,
  };
}

export const NO_SELF_HOSTED = "No self-hosted providers";

/**
 * Empty-state title for the Live throughput card, or null when the snapshot
 * carries a throughput series. The series comes from the request log, so it
 * is empty only when the org has no self-hosted (VPC) provider, whatever the
 * inference server's state.
 */
export function throughputEmptyTitle(points: ThroughputPoint[]): string | null {
  return points.length > 0 ? null : NO_SELF_HOSTED;
}

/** Rows coarser than this come from the cron's 10-minute rollups. */
const ROLLUP_BUCKET_S = 600;

/**
 * Subtitle of the past-range view. 10-minute rollups are written by a 5-min
 * cron for completed buckets only, so the newest ~15 min are not there yet.
 */
export function historySubtitle(bucketS: number): string {
  const base = `Stored samples, ${bucketLabel(bucketS)} resolution`;
  return bucketS >= ROLLUP_BUCKET_S
    ? `${base} · latest ~15 min not yet rolled up`
    : base;
}

/** True when a history response holds at least one stored row. */
export function hasStoredSamples(h: LiveHistory): boolean {
  return (
    h.throughput.length > 0 ||
    (h.host?.points.length ?? 0) > 0 ||
    (h.inference?.points.length ?? 0) > 0
  );
}

export function fmtGb(bytes: number | null): string {
  return bytes === null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function fmtC(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} °C`;
}

/** A 0-100 value (already a percentage) as "42%". */
export function fmtPctValue(value: number | null): string {
  return value === null ? "Unavailable" : pct(value / 100);
}

/** Charts sharing this id move their hover cursor and tooltip together. */
export const LIVE_SYNC_ID = "live";

/**
 * Recharts `syncMethod`: index of the tick nearest in time to the hovered
 * one, so charts with different sample times (2 s polls, 10 s buckets) still
 * line up. Ticks are in time order; -1 when there is nothing to match.
 */
export function nearestTick(
  ticks: { value?: unknown }[],
  hovered: { activeLabel?: unknown },
): number {
  const target = Number(hovered.activeLabel);
  if (ticks.length === 0 || !Number.isFinite(target)) return -1;
  let lo = 0;
  let hi = ticks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(ticks[mid].value) < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const before = Number(ticks[lo - 1].value);
  const after = Number(ticks[lo].value);
  return target - before <= after - target ? lo - 1 : lo;
}

/** Spread on every Live chart so their cursors stay in step. */
export const LIVE_SYNC = {
  syncId: LIVE_SYNC_ID,
  syncMethod: nearestTick,
} as const;

/** "42%" for a 0-100 value. */
export function fmtPctTick(value: number): string {
  return `${Math.round(value)}%`;
}
