/** Relative time ranges shared by the dashboard, analytics and explorer. */

export const RANGE_PRESETS = [
  { value: "1h", label: "Last hour", short: "1h", seconds: 3600 },
  { value: "24h", label: "Last 24 hours", short: "24h", seconds: 24 * 3600 },
  { value: "7d", label: "Last 7 days", short: "7d", seconds: 7 * 24 * 3600 },
  {
    value: "30d",
    label: "Last 30 days",
    short: "30d",
    seconds: 30 * 24 * 3600,
  },
  {
    value: "90d",
    label: "Last 90 days",
    short: "90d",
    seconds: 90 * 24 * 3600,
  },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["value"];
export type RangeOption = (typeof RANGE_PRESETS)[number];

export const ALL_RANGES: RangePreset[] = RANGE_PRESETS.map((r) => r.value);

export function rangeOption(range: RangePreset): RangeOption {
  return RANGE_PRESETS.find((r) => r.value === range)!;
}

/** `raw` if it is one of `allowed`, else `fallback`. */
export function parseRange(
  raw: string | null,
  allowed: readonly RangePreset[],
  fallback: RangePreset,
): RangePreset {
  return raw !== null && (allowed as readonly string[]).includes(raw)
    ? (raw as RangePreset)
    : fallback;
}

/** [start, end) in unix seconds for a preset, ending at `nowMs`. */
export function rangeWindow(
  range: RangePreset,
  nowMs: number,
): { start: number; end: number } {
  const end = Math.floor(nowMs / 1000) + 1;
  return { start: end - rangeOption(range).seconds, end };
}

/** One point per bucket in [start, end); buckets with no rows get `empty`. */
export function fillBuckets<T extends { t: number }>(
  points: T[],
  start: number,
  end: number,
  bucketSeconds: number,
  empty: (t: number) => T,
): T[] {
  const byT = new Map(points.map((p) => [p.t, p]));
  const out: T[] = [];
  for (let t = start - (start % bucketSeconds); t < end; t += bucketSeconds) {
    out.push(byT.get(t) ?? empty(t));
  }
  return out;
}
