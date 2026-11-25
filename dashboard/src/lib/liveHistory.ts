// [fork] W12: turns the stored box history (GET /api/live/history) into the
// Live page's chart points and range summary.
import type {
  HostAvg,
  InferenceAvg,
  LiveHistory,
  Series,
  SeriesPoint,
} from "./api";
import type { LivePoint } from "./liveSeries";
import { fillBuckets, type RangePreset } from "./timeRange";

export const LIVE_RANGES: readonly (RangePreset | "live")[] = [
  "live",
  "1h",
  "6h",
  "24h",
  "7d",
  "30d",
  "90d",
  "1y",
];

const EMPTY_POINT = (t: number): LivePoint => ({
  t,
  decodeTps: null,
  prefillTps: null,
  cpuPercent: null,
  gpuBusyPercent: null,
  cpuTempC: null,
  gpuTempC: null,
  ssdTempC: null,
  gpuPowerW: null,
});

function byTs<T>(series: Series<T> | null): Map<number, SeriesPoint<T>> {
  return new Map((series?.points ?? []).map((p) => [p.ts, p]));
}

/**
 * One point per bucket in [from, to). Buckets with no stored row are all-null
 * so charts break at gaps; a stored throughput of 0 stays 0 (idle).
 */
export function historyPoints(h: LiveHistory): LivePoint[] {
  const host = byTs(h.host);
  const throughput = new Map(
    h.throughput.map((p) => [Math.floor(p.ts / h.bucketS) * h.bucketS, p]),
  );
  const stored: LivePoint[] = [];
  const stamps = new Set([...host.keys(), ...throughput.keys()]);
  for (const ts of stamps) {
    const hostAvg = host.get(ts)?.avg;
    const tp = throughput.get(ts);
    stored.push({
      t: ts,
      decodeTps: tp?.decodeTps ?? null,
      prefillTps: tp?.prefillTps ?? null,
      cpuPercent: hostAvg?.cpu_busy_pct ?? null,
      gpuBusyPercent: hostAvg?.gpu_busy_pct ?? null,
      cpuTempC: hostAvg?.cpu_temp_c ?? null,
      gpuTempC: hostAvg?.gpu_temp_c ?? null,
      ssdTempC: hostAvg?.ssd_temp_c ?? null,
      gpuPowerW: hostAvg?.gpu_power_w ?? null,
    });
  }
  return fillBuckets(stored, h.from, h.to, h.bucketS, EMPTY_POINT).map((p) => ({
    ...p,
    t: p.t * 1000,
  }));
}

export interface RangeSummary {
  avgDecodeTps: number | null;
  peakDecodeTps: number | null;
  peakQueued: number | null;
  avgKvPct: number | null;
  peakKvPct: number | null;
  avgCacheHitPct: number | null;
  avgDraftPct: number | null;
  peakCpuPct: number | null;
  peakGpuPct: number | null;
  peakGpuMemBytes: number | null;
  peakCpuTempC: number | null;
  peakGpuTempC: number | null;
}

function mean(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => x != null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

function peak(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => x != null);
  return v.length === 0 ? null : Math.max(...v);
}

const pct = (v: number | null): number | null => (v === null ? null : v * 100);

/** Peak of a column: the bucket's max when stored, else its average. */
function peakOf<T, K extends keyof T & string>(
  series: Series<T> | null,
  key: K,
): number | null {
  return peak(
    (series?.points ?? []).map(
      (p) => (p.max[key] ?? p.avg[key]) as number | null,
    ),
  );
}

function avgOf<T, K extends keyof T & string>(
  series: Series<T> | null,
  key: K,
): number | null {
  return mean((series?.points ?? []).map((p) => p.avg[key] as number | null));
}

/** Headline numbers for the selected range. */
export function summarize(h: LiveHistory): RangeSummary {
  const inf: Series<InferenceAvg> | null = h.inference;
  const host: Series<HostAvg> | null = h.host;
  return {
    avgDecodeTps: mean(h.throughput.map((p) => p.decodeTps)),
    peakDecodeTps: peak(h.throughput.map((p) => p.decodeTpsMax ?? p.decodeTps)),
    peakQueued: peakOf(inf, "queued"),
    avgKvPct: pct(avgOf(inf, "kv_usage_ratio")),
    peakKvPct: pct(peakOf(inf, "kv_usage_ratio")),
    avgCacheHitPct: pct(avgOf(inf, "cache_hit_ratio")),
    avgDraftPct: pct(avgOf(inf, "draft_accept_ratio")),
    peakCpuPct: peakOf(host, "cpu_busy_pct"),
    peakGpuPct: peakOf(host, "gpu_busy_pct"),
    peakGpuMemBytes: peakOf(host, "gpu_mem_used_bytes"),
    peakCpuTempC: peakOf(host, "cpu_temp_c"),
    peakGpuTempC: peakOf(host, "gpu_temp_c"),
  };
}
