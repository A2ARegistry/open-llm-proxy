// [fork] W12: decode/prefill tok/s from the request log, not box counters
// (Halogen's token counters only move when a request finishes).

export interface ThroughputRequest {
  /** Unix seconds when the request finished. */
  timestamp: number;
  latency_ms: number;
  ttft_ms: number | null;
  decode_ms: number | null;
  /** Prompt tokens that were actually processed (cache reads excluded). */
  prefill_tokens: number;
  tokens_output: number;
}

export interface ThroughputPoint {
  ts: number;
  decodeTps: number;
  prefillTps: number;
}

export interface ThroughputRollup {
  ts: number;
  decode_tps: number;
  decode_tps_max: number;
  prefill_tps: number;
  prefill_tps_max: number;
}

const ROLLUP_S = 600;
/**
 * Upper bound on a request's latency, in seconds. Lets a past-window query
 * stop at `to + MAX_REQUEST_S` instead of scanning to the present: we assume
 * no request runs longer than 1 h, so one that finished later than that
 * after the window cannot have started inside it.
 */
export const MAX_REQUEST_S = 3600;

/** `[start, end)` of the prefill and decode phases, in unix seconds. */
function phases(r: ThroughputRequest): {
  prefill: [number, number];
  decode: [number, number];
} {
  const start = r.timestamp - r.latency_ms / 1000;
  if (r.ttft_ms === null || r.decode_ms === null) {
    const whole: [number, number] = [start, r.timestamp];
    return { prefill: whole, decode: whole };
  }
  const split = start + r.ttft_ms / 1000;
  return {
    prefill: [start, split],
    decode: [split, split + r.decode_ms / 1000],
  };
}

/** Add `tokens` to `sums`, split across buckets in proportion to overlap. */
function spread(
  sums: number[],
  tokens: number,
  [start, end]: [number, number],
  from: number,
  bucketS: number,
): void {
  if (tokens <= 0) return;
  if (end <= start) {
    // Zero-length phase: all tokens land in the bucket holding its start.
    const i = Math.floor((start - from) / bucketS);
    if (i >= 0 && i < sums.length) sums[i] += tokens;
    return;
  }
  const rate = tokens / (end - start);
  const first = Math.max(0, Math.floor((start - from) / bucketS));
  const last = Math.min(sums.length - 1, Math.floor((end - from) / bucketS));
  for (let i = first; i <= last; i++) {
    const lo = Math.max(start, from + i * bucketS);
    const hi = Math.min(end, from + (i + 1) * bucketS);
    if (hi > lo) sums[i] += rate * (hi - lo);
  }
}

/**
 * Tok/s per `bucketS` bucket over `[from, to)`: one point per bucket, zeros
 * where idle (so "idle" is distinguishable from a gap).
 */
export function spreadThroughput(
  rows: ThroughputRequest[],
  from: number,
  to: number,
  bucketS: number,
): ThroughputPoint[] {
  const n = Math.ceil((to - from) / bucketS);
  const decode = new Array<number>(n).fill(0);
  const prefill = new Array<number>(n).fill(0);
  for (const row of rows) {
    const p = phases(row);
    spread(prefill, row.prefill_tokens, p.prefill, from, bucketS);
    spread(decode, row.tokens_output, p.decode, from, bucketS);
  }
  return decode.map((d, i) => ({
    ts: from + i * bucketS,
    decodeTps: d / bucketS,
    prefillTps: prefill[i] / bucketS,
  }));
}

/**
 * Requests overlapping each `bucketS` bucket of `[from, to)`; a request
 * covers `[timestamp - latency, timestamp]` (a zero-latency one, its instant).
 */
export function countRequests(
  rows: ThroughputRequest[],
  from: number,
  to: number,
  bucketS: number,
): number[] {
  const counts = new Array<number>(Math.ceil((to - from) / bucketS)).fill(0);
  for (const row of rows) {
    const start = row.timestamp - row.latency_ms / 1000;
    const first = Math.max(0, Math.floor((start - from) / bucketS));
    const last = Math.min(
      counts.length - 1,
      Math.floor((row.timestamp - from) / bucketS),
    );
    for (let i = first; i <= last; i++) counts[i] += 1;
  }
  return counts;
}

/** 10-minute avg (mean of the 10 s values) and max per bucket. */
export function rollupThroughput(
  points10s: ThroughputPoint[],
): ThroughputRollup[] {
  const groups = new Map<number, ThroughputPoint[]>();
  for (const p of points10s) {
    const ts = Math.floor(p.ts / ROLLUP_S) * ROLLUP_S;
    groups.set(ts, [...(groups.get(ts) ?? []), p]);
  }
  return [...groups].map(([ts, pts]) => ({
    ts,
    decode_tps: mean(pts.map((p) => p.decodeTps)),
    decode_tps_max: Math.max(...pts.map((p) => p.decodeTps)),
    prefill_tps: mean(pts.map((p) => p.prefillTps)),
    prefill_tps_max: Math.max(...pts.map((p) => p.prefillTps)),
  }));
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Rows of finished requests overlapping `[from, to)`, as a statement for the
 * caller's own `DB.batch`. Bounded to requests finishing before
 * `to + MAX_REQUEST_S`. Errors and response-cache hits are skipped;
 * `prefill_tokens` excludes prompt-cache reads.
 */
export function throughputRowsStatement(
  env: Env,
  orgId: string,
  providers: string[],
  from: number,
  to: number,
): D1PreparedStatement {
  const marks = providers.map(() => "?").join(", ");
  return env.DB.prepare(
    `SELECT timestamp, latency_ms, ttft_ms, decode_ms,
            MAX(0, COALESCE(tokens_input, 0)
                   - COALESCE(tokens_cache_read, tokens_cached, 0)) AS prefill_tokens,
            COALESCE(tokens_output, 0) AS tokens_output
       FROM request_metrics
      WHERE organization_id = ?
        AND provider IN (${marks})
        AND status_code < 400
        AND cache_hit = 0
        AND timestamp >= ?
        AND timestamp < ?
        AND timestamp - latency_ms / 1000.0 < ?
      ORDER BY timestamp`,
  ).bind(orgId, ...providers, from, to + MAX_REQUEST_S, to);
}
