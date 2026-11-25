// [fork] W13: one batched read of everything the Power page needs.
// Energy comes from host_samples: 10-minute rollups, with raw 10 s rows used
// for buckets that have no rollup (the unfinished bucket, or one a long cron
// outage skipped). Tokens come from the org's box requests in request_metrics.
import { hostBinding } from "../live/sources";
import { vpcBindingNames } from "../llm/transport";
import { safeJsonParse } from "../utils/crypto";
import type { Period } from "./periods";
import type { PowerSettings } from "./power-settings";
import type { PeriodRaw, TokenSums } from "./power-summary";

const ROLLUP_S = 600;
const RAW_S = 10;
const IDLE_WINDOW_S = 30 * 86400;

export interface PowerData {
  settings: PowerSettings;
  /** First stored host sample of the org's box; null when there is none. */
  dataStart: number | null;
  periods: PeriodRaw[];
  /** p10 of 10-minute average APU watts over the last 30 days. */
  idleP10W: number | null;
}

interface EnergyRow {
  i: number;
  ws: number;
  secs: number;
  peak: number | null;
}

interface TokenRow {
  i: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  requests: number;
}

const PERIODS_CTE = `p AS (
  SELECT CAST(key AS INTEGER) AS i,
         json_extract(value, '$[0]') AS s,
         json_extract(value, '$[1]') AS e
    FROM json_each(?1))`;

const ENERGY_SQL = `WITH ${PERIODS_CTE},
r AS (
  SELECT ts, gpu_power_w * samples * ${RAW_S} AS ws, samples * ${RAW_S} AS secs,
         COALESCE(gpu_power_w_max, gpu_power_w) AS peak
    FROM host_samples
   WHERE binding = ?2 AND resolution_s = ${ROLLUP_S} AND samples > 0
     AND gpu_power_w IS NOT NULL AND ts >= ?3 AND ts < ?4
  UNION ALL
  SELECT h.ts, h.gpu_power_w * ${RAW_S}, ${RAW_S}, h.gpu_power_w
    FROM host_samples h
   WHERE h.binding = ?2 AND h.resolution_s = ${RAW_S} AND h.ok = 1
     AND h.gpu_power_w IS NOT NULL AND h.ts >= ?3 AND h.ts < ?4
     AND NOT EXISTS (
       SELECT 1 FROM host_samples x
        WHERE x.binding = h.binding AND x.resolution_s = ${ROLLUP_S}
          AND x.ts = h.ts - h.ts % ${ROLLUP_S}))
SELECT p.i, COALESCE(SUM(r.ws), 0) AS ws, COALESCE(SUM(r.secs), 0) AS secs,
       MAX(r.peak) AS peak
  FROM p LEFT JOIN r ON r.ts >= p.s AND r.ts < p.e
 GROUP BY p.i`;

const TOKENS_SQL = `WITH ${PERIODS_CTE},
m AS (
  SELECT timestamp AS ts, COALESCE(tokens_input, 0) AS input,
         COALESCE(tokens_output, 0) AS output,
         COALESCE(tokens_cache_read, 0) AS cache_read,
         COALESCE(tokens_cache_write, 0) AS cache_write
    FROM request_metrics
   WHERE organization_id = ?2 AND timestamp >= ?3 AND timestamp < ?4
     AND status_code < 400 AND COALESCE(cache_hit, 0) = 0
     AND timestamp >= (SELECT MIN(ts) FROM host_samples WHERE binding = ?5)
     AND provider IN (
       SELECT provider FROM provider_configs
        WHERE organization_id = ?2
          AND json_extract(config, '$.settings.transport') = 'vpc'
          AND json_extract(config, '$.settings.vpcBinding')
              IN (SELECT value FROM json_each(?6))))
SELECT p.i, COALESCE(SUM(m.input), 0) AS input, COALESCE(SUM(m.output), 0) AS output,
       COALESCE(SUM(m.cache_read), 0) AS cache_read,
       COALESCE(SUM(m.cache_write), 0) AS cache_write, COUNT(m.ts) AS requests
  FROM p LEFT JOIN m ON m.ts >= p.s AND m.ts < p.e
 GROUP BY p.i`;

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
    };
  }

  const json = JSON.stringify(periods.map((p) => [p.start, p.end]));
  const from = Math.min(...periods.map((p) => p.start));
  const to = Math.max(...periods.map((p) => p.end));
  const [settings, first, energy, tokens, idle] = await env.DB.batch<unknown>([
    settingsStmt,
    env.DB.prepare(
      "SELECT MIN(ts) AS first FROM host_samples WHERE binding = ?",
    ).bind(host.name),
    env.DB.prepare(ENERGY_SQL).bind(json, host.name, from, to),
    env.DB.prepare(TOKENS_SQL).bind(
      json,
      orgId,
      from,
      to,
      host.name,
      JSON.stringify(vpcBindingNames(env, orgId)),
    ),
    env.DB.prepare(IDLE_SQL).bind(host.name, now - IDLE_WINDOW_S),
  ]);

  const energyRows = energy.results as EnergyRow[];
  const tokenRows = tokens.results as TokenRow[];
  const out = emptyPeriods(periods);
  for (const row of energyRows) {
    out[row.i].measuredWs = row.ws;
    out[row.i].measuredS = row.secs;
    out[row.i].peakW = row.peak;
  }
  for (const row of tokenRows) {
    out[row.i].tokens = {
      input: row.input,
      output: row.output,
      cacheRead: row.cache_read,
      cacheWrite: row.cache_write,
      requests: row.requests,
    };
  }
  return {
    settings: parseSettings(
      (settings.results[0] as { value: string } | undefined)?.value,
    ),
    dataStart:
      (first.results[0] as { first: number | null } | undefined)?.first ?? null,
    periods: out,
    idleP10W: (idle.results[0] as { w: number } | undefined)?.w ?? null,
  };
}

function parseSettings(value: string | undefined): PowerSettings {
  return safeJsonParse<PowerSettings>(value, {});
}
