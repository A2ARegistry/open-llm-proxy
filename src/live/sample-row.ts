// [fork] W12: one stored row per source per 10 s tick. Rates come from counter
// deltas between two snapshots (same rules as the dashboard's liveSeries): a
// counter that went down (restart), no previous snapshot, or a gap longer than
// MAX_GAP_S (box unreachable in between) gives null, never a fake value.
// Throughput (decode/prefill tok/s) is not stored here: it is computed from
// the request log.
import type { HostSnapshot, InferenceSnapshot } from "./snapshot";

export const SAMPLE_INTERVAL_S = 10;
export const ROLLUP_S = 600;
/** Longest interval still turned into a rate (2.5 sample intervals). */
const MAX_GAP_S = SAMPLE_INTERVAL_S * 2.5;

export interface InferenceSampleRow {
  binding: string;
  ts: number;
  ok: 0 | 1;
  slots: number | null;
  version: string | null;
  in_flight: number | null;
  queued: number | null;
  longest_wait_s: number | null;
  kv_usage_ratio: number | null;
  kv_reserved_tokens: number | null;
  cache_hit_ratio: number | null;
  cache_saved_tps: number | null;
  draft_accept_ratio: number | null;
}

export interface HostSampleRow {
  binding: string;
  ts: number;
  ok: 0 | 1;
  cpu_busy_pct: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  gpu_busy_pct: number | null;
  gpu_mem_used_bytes: number | null;
  gpu_mem_total_bytes: number | null;
  cpu_temp_c: number | null;
  gpu_temp_c: number | null;
  ssd_temp_c: number | null;
  gpu_power_w: number | null;
}

/** Insert column order for `inference_samples` (after `resolution_s`). */
export const INFERENCE_COLUMNS: (keyof InferenceSampleRow)[] = [
  "binding",
  "ts",
  "ok",
  "slots",
  "version",
  "in_flight",
  "queued",
  "longest_wait_s",
  "kv_usage_ratio",
  "kv_reserved_tokens",
  "cache_hit_ratio",
  "cache_saved_tps",
  "draft_accept_ratio",
];

/** Insert column order for `host_samples` (after `resolution_s`). */
export const HOST_COLUMNS: (keyof HostSampleRow)[] = [
  "binding",
  "ts",
  "ok",
  "cpu_busy_pct",
  "mem_used_bytes",
  "mem_total_bytes",
  "gpu_busy_pct",
  "gpu_mem_used_bytes",
  "gpu_mem_total_bytes",
  "cpu_temp_c",
  "gpu_temp_c",
  "ssd_temp_c",
  "gpu_power_w",
];

function delta(
  prev: number | null | undefined,
  next: number | null | undefined,
): number | null {
  if (prev == null || next == null || next < prev) return null;
  return next - prev;
}

function ratio(num: number | null, den: number | null): number | null {
  if (num == null || den == null || den === 0) return null;
  return num / den;
}

/** Seconds between two snapshots, or 0 (no rates) when missing or too far apart. */
function interval(
  prev: { sampledAt: number } | null,
  next: { sampledAt: number },
): number {
  if (!prev) return 0;
  const s = (next.sampledAt - prev.sampledAt) / 1000;
  return s > 0 && s <= MAX_GAP_S ? s : 0;
}

function sum(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a + b;
}

/** Row for `binding` at `ts` (unix s); `next === null` means the source was unreachable. */
export function toInferenceRow(
  binding: string,
  ts: number,
  prev: InferenceSnapshot | null,
  next: InferenceSnapshot | null,
): InferenceSampleRow {
  if (!next) {
    return {
      binding,
      ts,
      ok: 0,
      slots: null,
      version: null,
      in_flight: null,
      queued: null,
      longest_wait_s: null,
      kv_usage_ratio: null,
      kv_reserved_tokens: null,
      cache_hit_ratio: null,
      cache_saved_tps: null,
      draft_accept_ratio: null,
    };
  }
  const seconds = interval(prev, next);
  const hits = delta(prev?.cacheHitsTotal, next.cacheHitsTotal);
  const misses = delta(prev?.cacheMissesTotal, next.cacheMissesTotal);
  const saved = delta(prev?.cacheTokensSavedTotal, next.cacheTokensSavedTotal);
  const drafted = delta(prev?.draftTokensTotal, next.draftTokensTotal);
  const accepted = delta(prev?.draftAcceptedTotal, next.draftAcceptedTotal);
  const rated = seconds > 0;
  return {
    binding,
    ts,
    ok: 1,
    slots: next.slots,
    version: next.version,
    in_flight: next.inFlight,
    queued: next.queued,
    longest_wait_s: next.longestWaitS,
    kv_usage_ratio: next.kvUsageRatio,
    kv_reserved_tokens: next.kvReservedTokens,
    cache_hit_ratio: rated ? ratio(hits, sum(hits, misses)) : null,
    cache_saved_tps: rated && saved !== null ? saved / seconds : null,
    draft_accept_ratio: rated ? ratio(accepted, drafted) : null,
  };
}

/** Row for the host `binding` at `ts` (unix s); `next === null` means node-exporter was unreachable. */
export function toHostRow(
  binding: string,
  ts: number,
  prev: HostSnapshot | null,
  next: HostSnapshot | null,
): HostSampleRow {
  if (!next) {
    return {
      binding,
      ts,
      ok: 0,
      cpu_busy_pct: null,
      mem_used_bytes: null,
      mem_total_bytes: null,
      gpu_busy_pct: null,
      gpu_mem_used_bytes: null,
      gpu_mem_total_bytes: null,
      cpu_temp_c: null,
      gpu_temp_c: null,
      ssd_temp_c: null,
      gpu_power_w: null,
    };
  }
  const idleShare =
    interval(prev, next) > 0
      ? ratio(
          delta(prev?.cpuIdleSecondsTotal, next.cpuIdleSecondsTotal),
          delta(prev?.cpuSecondsTotal, next.cpuSecondsTotal),
        )
      : null;
  return {
    binding,
    ts,
    ok: 1,
    cpu_busy_pct: idleShare === null ? null : 100 * (1 - idleShare),
    mem_used_bytes:
      next.memTotalBytes == null || next.memAvailableBytes == null
        ? null
        : next.memTotalBytes - next.memAvailableBytes,
    mem_total_bytes: next.memTotalBytes,
    gpu_busy_pct: next.gpuBusyPercent,
    gpu_mem_used_bytes: next.gpuMemUsedBytes,
    gpu_mem_total_bytes: next.gpuMemTotalBytes,
    cpu_temp_c: next.cpuTempC,
    gpu_temp_c: next.gpuTempC,
    ssd_temp_c: next.ssdTempC,
    gpu_power_w: next.gpuPowerW,
  };
}
