/** Windows up to this long are bucketed by hour, longer ones by day. */
const HOURLY_MAX_SECONDS = 48 * 3600;

/** One time bucket of a key's traffic. */
export interface KeySeriesPoint {
  /** Bucket start, unix seconds (UTC hour or day). */
  t: number;
  requests: number;
  errors: number;
  costUsd: number;
}

/** Requests and cost per provider + model for one key. */
export interface KeyModelUsage {
  provider: string;
  model: string;
  requests: number;
  errors: number;
  costUsd: number;
}

/** Totals for one key over the window. */
export interface KeyWindowSummary {
  requests: number;
  /** Requests with status >= 400. */
  errors: number;
  /** Uncached input tokens; cache reads are separate. */
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  costUsd: number;
  latencyAvgMs: number | null;
  /** Unix seconds of the newest request in the window, or null. */
  lastRequestAt: number | null;
}

export interface KeyDetailUsage {
  start: number;
  end: number;
  bucketSeconds: number;
  summary: KeyWindowSummary;
  series: KeySeriesPoint[];
  models: KeyModelUsage[];
  /** All-time spend, the figure the key's spend cap is checked against. */
  lifetimeCostUsd: number;
}

interface SummaryRow {
  requests: number;
  errors: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  cost_usd: number | null;
  latency_avg_ms: number | null;
  last_request_at: number | null;
}

export function bucketSecondsFor(start: number, end: number): number {
  return end - start <= HOURLY_MAX_SECONDS ? 3600 : 86400;
}

/**
 * Window totals, a time series, a per-model split and lifetime spend for one
 * API key. All four queries go to D1 in one batch (one round trip).
 */
export async function keyDetailUsage(
  env: Env,
  organizationId: string,
  apiKeyId: string,
  start: number,
  end: number,
): Promise<KeyDetailUsage> {
  const bucket = bucketSecondsFor(start, end);
  const scope =
    "organization_id = ? AND api_key_id = ? AND timestamp >= ? AND timestamp < ?";
  const params = [organizationId, apiKeyId, start, end];

  const [summary, series, models, lifetime] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
              SUM(tokens_input) AS tokens_input,
              SUM(tokens_output) AS tokens_output,
              SUM(tokens_cache_read) AS tokens_cache_read,
              SUM(cost_usd) AS cost_usd,
              ROUND(AVG(latency_ms)) AS latency_avg_ms,
              MAX(timestamp) AS last_request_at
       FROM request_metrics WHERE ${scope}`,
    ).bind(...params),
    // `%` keeps integer math; D1 binds numbers as REAL, so `/ ?` would not
    // truncate to the bucket start.
    env.DB.prepare(
      `SELECT timestamp - (timestamp % ?) AS t,
              COUNT(*) AS requests,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM request_metrics WHERE ${scope}
       GROUP BY t ORDER BY t ASC`,
    ).bind(bucket, ...params),
    env.DB.prepare(
      `SELECT provider, model, COUNT(*) AS requests,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(cost_usd), 0) AS costUsd
       FROM request_metrics WHERE ${scope}
       GROUP BY provider, model ORDER BY requests DESC, provider, model`,
    ).bind(...params),
    env.DB.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM request_metrics WHERE organization_id = ? AND api_key_id = ?`,
    ).bind(organizationId, apiKeyId),
  ]);

  const s = summary.results[0] as SummaryRow;
  return {
    start,
    end,
    bucketSeconds: bucket,
    summary: {
      requests: s.requests,
      errors: s.errors ?? 0,
      tokensInput: s.tokens_input ?? 0,
      tokensOutput: s.tokens_output ?? 0,
      tokensCacheRead: s.tokens_cache_read ?? 0,
      costUsd: s.cost_usd ?? 0,
      latencyAvgMs: s.latency_avg_ms,
      lastRequestAt: s.last_request_at,
    },
    series: series.results as unknown as KeySeriesPoint[],
    models: models.results as unknown as KeyModelUsage[],
    lifetimeCostUsd: (lifetime.results[0] as { cost_usd: number }).cost_usd,
  };
}
