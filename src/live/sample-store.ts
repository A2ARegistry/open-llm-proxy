// [fork] W12: D1 storage of box samples: 10 s rows, 10-minute rollups, prune.
import { rollupWindow } from "./rollup-window";
import {
  HOST_COLUMNS,
  INFERENCE_COLUMNS,
  ROLLUP_S,
  SAMPLE_INTERVAL_S,
  type HostSampleRow,
  type InferenceSampleRow,
} from "./sample-row";

/** D1 allows 100 bound parameters per statement. */
const MAX_PARAMS = 100;
const RAW_RETENTION_S = 30 * 86400;

const INFERENCE_AVG = [
  "in_flight",
  "queued",
  "longest_wait_s",
  "kv_usage_ratio",
  "kv_reserved_tokens",
  "cache_hit_ratio",
  "cache_saved_tps",
  "draft_accept_ratio",
];
export const INFERENCE_MAX = [
  "in_flight",
  "queued",
  "longest_wait_s",
  "kv_usage_ratio",
];
const HOST_AVG = [
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
export const HOST_MAX = [
  "cpu_busy_pct",
  "gpu_busy_pct",
  "mem_used_bytes",
  "gpu_mem_used_bytes",
  "cpu_temp_c",
  "gpu_temp_c",
  "gpu_power_w",
];

/** Multi-row INSERT OR REPLACE statements (resolution_s = 10), each <= 100 params. */
function insertRows<T extends object>(
  env: Env,
  table: string,
  columns: (keyof T)[],
  rows: T[],
): D1PreparedStatement[] {
  const perStatement = Math.floor(MAX_PARAMS / columns.length);
  const names = ["binding", "resolution_s", ...columns.slice(1)].join(", ");
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    const tuple = `(?, ${SAMPLE_INTERVAL_S}, ${columns
      .slice(1)
      .map(() => "?")
      .join(", ")})`;
    statements.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO ${table} (${names}) VALUES ${chunk
          .map(() => tuple)
          .join(", ")}`,
      ).bind(...chunk.flatMap((row) => columns.map((c) => row[c] ?? null))),
    );
  }
  return statements;
}

export function insertStatements(
  env: Env,
  inference: InferenceSampleRow[],
  host: HostSampleRow[],
): D1PreparedStatement[] {
  return [
    ...insertRows(env, "inference_samples", INFERENCE_COLUMNS, inference),
    ...insertRows(env, "host_samples", HOST_COLUMNS, host),
  ];
}

/** Write one flush of samples in a single D1 batch. */
export async function writeSamples(
  env: Env,
  inference: InferenceSampleRow[],
  host: HostSampleRow[],
): Promise<void> {
  const statements = insertStatements(env, inference, host);
  if (statements.length === 0) return;
  await env.DB.batch(statements);
}

function rollupStatement(
  env: Env,
  table: string,
  extra: string[],
  avg: string[],
  max: string[],
  from: number,
  to: number,
): D1PreparedStatement {
  const columns = [
    "binding",
    "resolution_s",
    "ts",
    "ok",
    "samples",
    ...extra,
    ...avg,
    ...max.map((c) => `${c}_max`),
  ];
  const select = [
    "binding",
    String(ROLLUP_S),
    `(ts / ${ROLLUP_S}) * ${ROLLUP_S}`,
    "MAX(ok)",
    "COUNT(CASE WHEN ok = 1 THEN 1 END)",
    ...extra.map((c) => `MAX(${c})`),
    ...avg.map((c) => `AVG(${c})`),
    ...max.map((c) => `MAX(${c})`),
  ];
  return env.DB.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(", ")})
     SELECT ${select.join(", ")} FROM ${table}
     WHERE resolution_s = ${SAMPLE_INTERVAL_S} AND ts >= ? AND ts < ?
     GROUP BY binding, ts / ${ROLLUP_S}`,
  ).bind(from, to);
}

function rollupStatements(
  env: Env,
  from: number,
  to: number,
): D1PreparedStatement[] {
  return [
    rollupStatement(
      env,
      "inference_samples",
      ["slots", "version"],
      INFERENCE_AVG,
      INFERENCE_MAX,
      from,
      to,
    ),
    rollupStatement(env, "host_samples", [], HOST_AVG, HOST_MAX, from, to),
  ];
}

/** Recompute the completed 10-minute buckets of the last 2 h (idempotent). */
export async function rollupRecent(env: Env, nowS: number): Promise<void> {
  const { from, to } = rollupWindow(nowS);
  await env.DB.batch(rollupStatements(env, from, to));
}

/**
 * Roll up whatever is about to expire, then drop 10 s rows older than 30 days.
 * The cutoff is bucket-aligned so a bucket is never half deleted.
 */
export async function pruneOld(env: Env, nowS: number): Promise<void> {
  const cutoff = Math.floor((nowS - RAW_RETENTION_S) / ROLLUP_S) * ROLLUP_S;
  await env.DB.batch([
    ...rollupStatements(env, 0, cutoff),
    ...["inference_samples", "host_samples"].map((table) =>
      env.DB.prepare(
        `DELETE FROM ${table} WHERE resolution_s = ${SAMPLE_INTERVAL_S} AND ts < ?`,
      ).bind(cutoff),
    ),
  ]);
}
