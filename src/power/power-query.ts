// [fork] W13: one batched read of everything the Power page needs.
// Energy comes from host_samples: 10-minute rollups (pro rata at unaligned
// range edges), with raw 10 s rows used for buckets that have no rollup.
// Tokens come from the org's box requests in request_metrics, priced at their
// model_pricing rates for the cloud comparison.
import { hostBinding } from "../live/sources";
import { vpcBindingNames } from "../llm/transport";
import type { ModelPricing } from "../metrics/cost-tracker";
import { safeJsonParse } from "../utils/crypto";
import type { Period } from "./periods";
import type { PowerSettings } from "./power-settings";
import type { PeriodRaw, TokenSums } from "./power-summary";

const ROLLUP_S = 600;
const RAW_S = 10;
const IDLE_WINDOW_S = 30 * 86400;
/** Raw 10 s rows are pruned after 30 days (history-cron). */
const RAW_RETENTION_S = 30 * 86400;

export interface PowerData {
  settings: PowerSettings;
  /** First stored host sample of the org's box; null when there is none. */
  dataStart: number | null;
  periods: PeriodRaw[];
  /** p10 of 10-minute average APU watts over the last 30 days. */
  idleP10W: number | null;
  /** model_pricing rows of the box's providers: the cloud comparison rates. */
  cloudRates: ModelPricing[];
}

interface EnergyRow {
  i: number;
  ws: number;
  secs: number;
  peak: number;
}

interface TokenRow {
  i: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  requests: number;
  cloud_usd: number;
  unpriced: number;
}

interface RateRow {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m: number;
  cache_write_per_1m: number;
}

const PERIODS_CTE = `p AS (
  SELECT CAST(key AS INTEGER) AS i,
         json_extract(value, '$[0]') AS s,
         json_extract(value, '$[1]') AS e
    FROM json_each(?1))`;

/** First host sample: two primary-key seeks (one per resolution), not a scan. */
const dataStartSql = (binding: string) => `SELECT MIN(m) AS first FROM (
    SELECT MIN(ts) AS m FROM host_samples
     WHERE binding = ${binding} AND resolution_s = ${ROLLUP_S}
    UNION ALL
    SELECT MIN(ts) FROM host_samples
     WHERE binding = ${binding} AND resolution_s = ${RAW_S})`;

// Rollups overlapping each period, counted pro rata at unaligned edges. The
// CROSS JOIN keeps the periods as the outer loop so each period is one
// primary-key range seek on host_samples.
const OVERLAP = `(MIN(h.ts + ${ROLLUP_S}, p.e) - MAX(h.ts, p.s)) * 1.0 / ${ROLLUP_S}`;
const ROLLUP_ENERGY_SQL = `WITH ${PERIODS_CTE}
SELECT p.i,
       SUM(h.gpu_power_w * h.samples * ${RAW_S} * ${OVERLAP}) AS ws,
       SUM(h.samples * ${RAW_S} * ${OVERLAP}) AS secs,
       MAX(COALESCE(h.gpu_power_w_max, h.gpu_power_w)) AS peak
  FROM p
  CROSS JOIN host_samples h
    ON h.binding = ?2 AND h.resolution_s = ${ROLLUP_S}
   AND h.ts > p.s - ${ROLLUP_S} AND h.ts < p.e
 WHERE h.samples > 0 AND h.gpu_power_w IS NOT NULL
 GROUP BY p.i`;

// Raw 10 s rows, read only for buckets that have no rollup (the unfinished
// bucket, or one a long cron outage skipped), within raw retention [?3, ?4).
const RAW_ENERGY_SQL = `WITH RECURSIVE ${PERIODS_CTE},
b(t) AS (
  SELECT ?3 WHERE ?3 < ?4
  UNION ALL
  SELECT t + ${ROLLUP_S} FROM b WHERE t + ${ROLLUP_S} < ?4),
missing AS (
  SELECT t FROM b
   WHERE NOT EXISTS (
     SELECT 1 FROM host_samples x
      WHERE x.binding = ?2 AND x.resolution_s = ${ROLLUP_S} AND x.ts = b.t)),
raw AS (
  SELECT h.ts, h.gpu_power_w AS w
    FROM missing m
    CROSS JOIN host_samples h
      ON h.binding = ?2 AND h.resolution_s = ${RAW_S}
     AND h.ts >= m.t AND h.ts < m.t + ${ROLLUP_S}
   WHERE h.ok = 1 AND h.gpu_power_w IS NOT NULL)
SELECT p.i, SUM(raw.w * ${RAW_S}) AS ws, COUNT(*) * ${RAW_S} AS secs,
       MAX(raw.w) AS peak
  FROM p JOIN raw ON raw.ts >= p.s AND raw.ts < p.e
 GROUP BY p.i`;

/** The org's providers that reach the box over VPC (`org` = org id, `bindings` = JSON array of binding names). */
const boxProvidersSql = (org: string, bindings: string) => `
  SELECT provider FROM provider_configs
   WHERE organization_id = ${org}
     AND json_extract(config, '$.settings.transport') = 'vpc'
     AND json_extract(config, '$.settings.vpcBinding')
         IN (SELECT value FROM json_each(${bindings}))`;

// Each request is priced from model_pricing like getModelPricing: the exact
// model row, else the provider's '*' row. Requests with neither are counted as
// unpriced instead of getting the hard-coded default.
const rate = (col: string) => `COALESCE(pe.${col}, pw.${col})`;
const TOKENS_SQL = `WITH ${PERIODS_CTE},
m AS (
  SELECT r.timestamp AS ts, COALESCE(r.tokens_input, 0) AS input,
         COALESCE(r.tokens_output, 0) AS output,
         COALESCE(r.tokens_cache_read, 0) AS cache_read,
         COALESCE(r.tokens_cache_write, 0) AS cache_write,
         ${rate("input_per_1m")} AS in_rate,
         ${rate("output_per_1m")} AS out_rate,
         ${rate("cache_read_per_1m")} AS cr_rate,
         ${rate("cache_write_per_1m")} AS cw_rate
    FROM request_metrics r
    LEFT JOIN model_pricing pe ON pe.provider = r.provider AND pe.model = r.model
    LEFT JOIN model_pricing pw ON pw.provider = r.provider AND pw.model = '*'
   WHERE r.organization_id = ?2 AND r.timestamp >= ?3 AND r.timestamp < ?4
     AND r.status_code < 400 AND COALESCE(r.cache_hit, 0) = 0
     AND r.timestamp >= (${dataStartSql("?5")})
     AND r.provider IN (${boxProvidersSql("?2", "?6")}))
SELECT p.i, COALESCE(SUM(m.input), 0) AS input, COALESCE(SUM(m.output), 0) AS output,
       COALESCE(SUM(m.cache_read), 0) AS cache_read,
       COALESCE(SUM(m.cache_write), 0) AS cache_write, COUNT(m.ts) AS requests,
       COALESCE(SUM((m.input * m.in_rate + m.output * m.out_rate
                     + m.cache_read * m.cr_rate + m.cache_write * m.cw_rate) / 1e6), 0)
         AS cloud_usd,
       COUNT(m.ts) - COUNT(m.in_rate) AS unpriced
  FROM p LEFT JOIN m ON m.ts >= p.s AND m.ts < p.e
 GROUP BY p.i`;

/** The model_pricing rows the box's requests can be priced from. */
const RATES_SQL = `SELECT provider, model, input_per_1m, output_per_1m,
       cache_read_per_1m, cache_write_per_1m
  FROM model_pricing
 WHERE provider IN (${boxProvidersSql("?1", "?2")})
 ORDER BY provider, model`;

const IDLE_SQL = `SELECT gpu_power_w AS w FROM (
  SELECT gpu_power_w, ROW_NUMBER() OVER (ORDER BY gpu_power_w) AS rn,
         COUNT(*) OVER () AS n
    FROM host_samples
   WHERE binding = ? AND resolution_s = ${ROLLUP_S} AND samples > 0
     AND gpu_power_w IS NOT NULL AND ts >= ?)
 WHERE rn = (n + 9) / 10`;

const EMPTY_TOKENS: TokenSums = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
};

function emptyPeriods(periods: Period[]): PeriodRaw[] {
  return periods.map((p) => ({
    start: p.start,
    end: p.end,
    measuredWs: 0,
    measuredS: 0,
    peakW: null,
    tokens: { ...EMPTY_TOKENS },
    cloudUsd: 0,
    unpricedRequests: 0,
  }));
}

/** Settings, data start, per-period energy and tokens, and idle p10 in one round trip. */
export async function loadPowerData(
  env: Env,
  orgId: string,
  periods: Period[],
  now: number,
): Promise<PowerData> {
  const settingsStmt = env.DB.prepare(
    "SELECT value FROM tenant_settings WHERE organization_id = ? AND key = 'power'",
  ).bind(orgId);
  const host = hostBinding(env, orgId);
  if (!host || periods.length === 0) {
    const [settings] = await env.DB.batch<{ value: string }>([settingsStmt]);
    return {
      settings: parseSettings(settings.results[0]?.value),
      dataStart: null,
      periods: emptyPeriods(periods),
      idleP10W: null,
      cloudRates: [],
    };
  }

  const json = JSON.stringify(periods.map((p) => [p.start, p.end]));
  const from = Math.min(...periods.map((p) => p.start));
  const to = Math.max(...periods.map((p) => p.end));
  const rawFrom = Math.max(from, now - RAW_RETENTION_S);
  const bindings = JSON.stringify(vpcBindingNames(env, orgId));
  const [settings, first, rollups, raw, tokens, idle, rates] =
    await env.DB.batch<unknown>([
      settingsStmt,
      env.DB.prepare(dataStartSql("?1")).bind(host.name),
      env.DB.prepare(ROLLUP_ENERGY_SQL).bind(json, host.name),
      env.DB.prepare(RAW_ENERGY_SQL).bind(
        json,
        host.name,
        rawFrom - (rawFrom % ROLLUP_S),
        Math.min(to, now + ROLLUP_S),
      ),
      env.DB.prepare(TOKENS_SQL).bind(
        json,
        orgId,
        from,
        to,
        host.name,
        bindings,
      ),
      env.DB.prepare(IDLE_SQL).bind(host.name, now - IDLE_WINDOW_S),
      env.DB.prepare(RATES_SQL).bind(orgId, bindings),
    ]);

  const tokenRows = tokens.results as TokenRow[];
  const out = emptyPeriods(periods);
  for (const row of [...rollups.results, ...raw.results] as EnergyRow[]) {
    const p = out[row.i];
    p.measuredWs += row.ws;
    p.measuredS += row.secs;
    p.peakW = p.peakW === null ? row.peak : Math.max(p.peakW, row.peak);
  }
  for (const row of tokenRows) {
    out[row.i].tokens = {
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      requests: row.requests,
    };
    out[row.i].cloudUsd = row.cloud_usd;
    out[row.i].unpricedRequests = row.unpriced;
  }
  return {
    settings: parseSettings(
      (settings.results[0] as { value: string } | undefined)?.value,
    ),
    dataStart:
      (first.results[0] as { first: number | null } | undefined)?.first ?? null,
    periods: out,
    idleP10W: (idle.results[0] as { w: number } | undefined)?.w ?? null,
    cloudRates: (rates.results as RateRow[]).map((r) => ({
      provider: r.provider,
      model: r.model,
      inputPer1m: r.input_per_1m,
      outputPer1m: r.output_per_1m,
      cacheReadPer1m: r.cache_read_per_1m,
      cacheWritePer1m: r.cache_write_per_1m,
    })),
  };
}

function parseSettings(value: string | undefined): PowerSettings {
  return safeJsonParse<PowerSettings>(value, {});
}
