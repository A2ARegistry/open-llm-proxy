// [fork] W12: pure helpers behind the Live page charts and range picker.
import type { LiveHistory, ThroughputPoint } from "./api";
import { pct } from "./format";
import { LIVE_RANGES } from "./liveHistory";
import { LIVE_HISTORY_POINTS, LIVE_POLL_MS } from "./liveSeries";
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
    if (prev && point.t - prev.t > gapMs) {
      out.push(
        Object.fromEntries(
          Object.keys(prev).map((k) => [
            k,
            k === "t" ? (prev.t + point.t) / 2 : null,
          ]),
        ) as T,
      );
    }
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

/** Latest and peak decode / prefill rate of a throughput series. */
export function throughputStats(points: ThroughputPoint[]): ThroughputStats {
  const last = points[points.length - 1];
  return {
    decodeNow: last?.decodeTps ?? null,
    prefillNow: last?.prefillTps ?? null,
    decodePeak: points.length
      ? Math.max(...points.map((p) => p.decodeTps))
      : null,
    prefillPeak: points.length
      ? Math.max(...points.map((p) => p.prefillTps))
      : null,
  };
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
