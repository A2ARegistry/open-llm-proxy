// [fork] W12: reads of the stored box history for the Live page.
// Every read is scoped to the bindings the org may use (inferenceBinding /
// hostBinding) and, for throughput, to the org's own request log or rollups.
import { providerVpcBinding, vpcProviders } from "./provider-binding";
import {
  HOST_COLUMNS,
  INFERENCE_COLUMNS,
  ROLLUP_S,
  SAMPLE_INTERVAL_S,
  type HostSampleRow,
  type InferenceSampleRow,
} from "./sample-row";
import { HOST_MAX, INFERENCE_MAX } from "./sample-store";
import { hostBinding, inferenceBinding } from "./sources";
import {
  spreadThroughput,
  throughputRowsStatement,
  type ThroughputRequest,
} from "./throughput";
import { throughputRollupsStatement } from "./throughput-store";

/** Ranges up to this many seconds read the raw 10 s rows. */
const RAW_RANGE_S = 7200;
const MAX_POINTS = 720;

export type InferenceAvg = Omit<InferenceSampleRow, "binding" | "ts" | "ok">;
export type HostAvg = Omit<HostSampleRow, "binding" | "ts" | "ok">;

export interface SeriesPoint<T> {
  ts: number;
  ok: 0 | 1;
  /** Raw rows ok in the bucket (10-minute rows only). */
  samples: number | null;
  avg: T;
  /** `*_max` columns without the suffix; empty for raw 10 s rows. */
  max: Partial<T>;
}

export interface ThroughputSeriesPoint {
  ts: number;
  decodeTps: number;
  prefillTps: number;
  decodeTpsMax: number | null;
  prefillTpsMax: number | null;
}

export interface Series<T> {
  binding: string;
  points: SeriesPoint<T>[];
}

export interface LiveHistory {
  from: number;
  to: number;
  bucketS: number;
  inference: Series<InferenceAvg> | null;
  host: Series<HostAvg> | null;
  throughput: ThroughputSeriesPoint[];
}

export interface SampleAt {
  /** The inference binding of the request's provider. */
  binding: string;
  /** Timestamp of the stored row that was picked. */
  ts: number;
  resolutionS: 10 | 600;
  inference: InferenceAvg | null;
  host: HostAvg | null;
}

/** Bucket width in seconds: 10 s up to 2 h, else 10-minute multiples keeping <= 720 points. */
export function historyBucket(from: number, to: number): number {
  const range = to - from;
  if (range <= RAW_RANGE_S) return SAMPLE_INTERVAL_S;
  return Math.max(
    ROLLUP_S,
    Math.ceil(range / MAX_POINTS / ROLLUP_S) * ROLLUP_S,
  );
}

interface TableSpec {
  table: string;
  /** Avg (value) columns, in table order. */
  values: string[];
  /** Columns that also have a `<c>_max` column. */
  max: string[];
  /** Value columns grouped with MAX instead of AVG (non-averageable). */
  extra: string[];
}

const KEYS = ["binding", "ts", "ok"];
const INFERENCE: TableSpec = {
  table: "inference_samples",
  values: INFERENCE_COLUMNS.filter((c) => !KEYS.includes(c)),
  max: INFERENCE_MAX,
  extra: ["slots", "version"],
};
const HOST: TableSpec = {
  table: "host_samples",
  values: HOST_COLUMNS.filter((c) => !KEYS.includes(c)),
  max: HOST_MAX,
  extra: [],
};

const maxName = (c: string) => `${c}_max`;

/** Raw 10 s rows of `[from, to)`. */
function rawStatement(
  env: Env,
  spec: TableSpec,
  binding: string,
  from: number,
  to: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT ts, ok, NULL AS samples, ${spec.values.join(", ")}
       FROM ${spec.table}
      WHERE binding = ? AND resolution_s = ${SAMPLE_INTERVAL_S}
        AND ts >= ? AND ts < ?
      ORDER BY ts`,
  ).bind(binding, from, to);
}

/** 10-minute rows of `[from, to)` grouped into `bucketS` buckets (avg of avgs, max of maxes). */
function groupedStatement(
  env: Env,
  spec: TableSpec,
  binding: string,
  from: number,
  to: number,
  bucketS: number,
): D1PreparedStatement {
  const select = [
    `(ts / ${bucketS}) * ${bucketS} AS ts`,
    "MAX(ok) AS ok",
    "SUM(samples) AS samples",
    ...spec.values.map((c) =>
      spec.extra.includes(c) ? `MAX(${c}) AS ${c}` : `AVG(${c}) AS ${c}`,
    ),
    ...spec.max.map((c) => `MAX(${maxName(c)}) AS ${maxName(c)}`),
  ];
  return env.DB.prepare(
    `SELECT ${select.join(", ")} FROM ${spec.table}
      WHERE binding = ? AND resolution_s = ${ROLLUP_S}
        AND ts >= ? AND ts < ?
      GROUP BY ts / ${bucketS}
      ORDER BY ts`,
  ).bind(binding, from, to);
}

type Raw = Record<string, number | string | null>;

function toPoint<T>(
  spec: TableSpec,
  row: Raw,
  withMax: boolean,
): SeriesPoint<T> {
  const pick = (cols: string[], name: (c: string) => string) =>
    Object.fromEntries(cols.map((c) => [c, row[name(c)] ?? null]));
  return {
    ts: row.ts as number,
    ok: row.ok as 0 | 1,
    samples: row.samples as number | null,
    avg: pick(spec.values, (c) => c) as T,
    max: (withMax ? pick(spec.max, maxName) : {}) as Partial<T>,
  };
}

function rollupGroups(
  rows: {
    ts: number;
    decode_tps: number;
    decode_tps_max: number;
    prefill_tps: number;
    prefill_tps_max: number;
  }[],
  bucketS: number,
): ThroughputSeriesPoint[] {
  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    const ts = Math.floor(r.ts / bucketS) * bucketS;
    groups.set(ts, [...(groups.get(ts) ?? []), r]);
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  return [...groups].map(([ts, g]) => ({
    ts,
    decodeTps: mean(g.map((r) => r.decode_tps)),
    prefillTps: mean(g.map((r) => r.prefill_tps)),
    decodeTpsMax: Math.max(...g.map((r) => r.decode_tps_max)),
    prefillTpsMax: Math.max(...g.map((r) => r.prefill_tps_max)),
  }));
}

/**
 * Stored history of `[from, to)` for the org's bindings. One `DB.batch` with
 * one SELECT per table; a short range first looks up the org's vpc providers
 * (throughput comes from the request log), a long one reads the rollups.
 */
export async function queryHistory(
  env: Env,
  orgId: string,
  from: number,
  to: number,
): Promise<LiveHistory> {
  const bucketS = historyBucket(from, to);
  const raw = bucketS === SAMPLE_INTERVAL_S;
  const inference = inferenceBinding(env, orgId);
  const host = hostBinding(env, orgId);
  const providers = raw
    ? (await vpcProviders(env, orgId)).map((p) => p.provider)
    : [];

  const read = (spec: TableSpec, binding: string) =>
    raw
      ? rawStatement(env, spec, binding, from, to)
      : groupedStatement(env, spec, binding, from, to, bucketS);
  const statements: D1PreparedStatement[] = [];
  if (inference) statements.push(read(INFERENCE, inference.name));
  if (host) statements.push(read(HOST, host.name));
  const wantsRequests = raw && providers.length > 0;
  if (wantsRequests) {
    statements.push(throughputRowsStatement(env, orgId, providers, from, to));
  }
  if (!raw) {
    statements.push(throughputRollupsStatement(env, orgId, from, to));
  }

  const results = statements.length ? await env.DB.batch<Raw>(statements) : [];
  let next = 0;
  const series = <T>(spec: TableSpec, binding: string | undefined) =>
    binding === undefined
      ? null
      : {
          binding,
          points: results[next++].results.map((r) => toPoint<T>(spec, r, !raw)),
        };
  const inferenceSeries = series<InferenceAvg>(INFERENCE, inference?.name);
  const hostSeries = series<HostAvg>(HOST, host?.name);

  let throughput: ThroughputSeriesPoint[] = [];
  if (wantsRequests) {
    const rows = results[next].results as unknown as ThroughputRequest[];
    throughput = spreadThroughput(rows, from, to, SAMPLE_INTERVAL_S).map(
      (p) => ({ ...p, decodeTpsMax: null, prefillTpsMax: null }),
    );
  } else if (!raw) {
    throughput = rollupGroups(
      results[next].results as unknown as Parameters<typeof rollupGroups>[0],
      bucketS,
    );
  }
  return {
    from,
    to,
    bucketS,
    inference: inferenceSeries,
    host: hostSeries,
    throughput,
  };
}

/** The 10 s row nearest `ts` within 10 s, and the 600 row holding `ts`. */
function nearStatements(
  env: Env,
  spec: TableSpec,
  binding: string,
  ts: number,
): D1PreparedStatement[] {
  const cols = ["ts", ...spec.values].join(", ");
  return [
    env.DB.prepare(
      `SELECT ${cols} FROM ${spec.table}
        WHERE binding = ? AND resolution_s = ${SAMPLE_INTERVAL_S}
          AND ts >= ? AND ts <= ?
        ORDER BY ABS(ts - ?), ts LIMIT 1`,
    ).bind(binding, ts - SAMPLE_INTERVAL_S, ts + SAMPLE_INTERVAL_S, ts),
    env.DB.prepare(
      `SELECT ${cols} FROM ${spec.table}
        WHERE binding = ? AND resolution_s = ${ROLLUP_S} AND ts = ?`,
    ).bind(binding, Math.floor(ts / ROLLUP_S) * ROLLUP_S),
  ];
}

interface Picked<T> {
  ts: number;
  resolutionS: 10 | 600;
  avg: T;
}

function pickRow<T>([near, rollup]: { results: Raw[] }[]): Picked<T> | null {
  const row = near.results[0] ?? rollup.results[0];
  if (!row) return null;
  const { ts, ...avg } = row;
  return {
    ts: ts as number,
    resolutionS: near.results[0] ? SAMPLE_INTERVAL_S : ROLLUP_S,
    avg: avg as T,
  };
}

/**
 * Box state around `ts` (unix s, a request's start) for a request to
 * `provider`: per table the nearest 10 s row within 10 s, else the 10-minute
 * row holding `ts`. Null when the provider is not a vpc provider of the org
 * or nothing is stored. One `DB.batch`.
 */
export async function sampleAt(
  env: Env,
  orgId: string,
  provider: string,
  ts: number,
): Promise<SampleAt | null> {
  const binding = await providerVpcBinding(env, orgId, provider);
  if (binding === null) return null;
  const host = hostBinding(env, orgId);
  const results = await env.DB.batch<Raw>([
    ...nearStatements(env, INFERENCE, binding, ts),
    ...(host ? nearStatements(env, HOST, host.name, ts) : []),
  ]);
  const inference = pickRow<InferenceAvg>(results.slice(0, 2));
  const hostRow = host ? pickRow<HostAvg>(results.slice(2, 4)) : null;
  const first = inference ?? hostRow;
  if (!first) return null;
  const rows = [inference, hostRow].filter((r) => r !== null);
  return {
    binding,
    ts: first.ts,
    resolutionS: rows.some((r) => r.resolutionS === SAMPLE_INTERVAL_S)
      ? SAMPLE_INTERVAL_S
      : ROLLUP_S,
    inference: inference?.avg ?? null,
    host: hostRow?.avg ?? null,
  };
}
