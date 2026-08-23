import type { TenantSettings } from "../db/tenant";
import { nowSeconds } from "../utils/crypto";

export interface ModelPricing {
  provider: string;
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheWritePer1m: number;
}

interface PricingRow {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m: number;
  cache_write_per_1m: number;
}

/** Conservative default pricing used when model_pricing has no row for the model. */
const DEFAULT_PRICING: ModelPricing = {
  provider: "*",
  model: "*",
  inputPer1m: 0.5,
  outputPer1m: 1.5,
  cacheReadPer1m: 0.1,
  cacheWritePer1m: 0.5,
};

export async function getModelPricing(
  env: Env,
  provider: string,
  model: string,
): Promise<ModelPricing> {
  const row = await env.DB.prepare(
    `SELECT provider, model, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m
     FROM model_pricing WHERE provider = ? AND model = ?`,
  )
    .bind(provider, model)
    .first<PricingRow>();
  if (row) {
    return {
      provider: row.provider,
      model: row.model,
      inputPer1m: row.input_per_1m,
      outputPer1m: row.output_per_1m,
      cacheReadPer1m: row.cache_read_per_1m,
      cacheWritePer1m: row.cache_write_per_1m,
    };
  }
  return { ...DEFAULT_PRICING };
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Cost in USD per million tokens. */
export function computeCostUsd(
  pricing: ModelPricing,
  usage: TokenUsage,
): number {
  return (
    (usage.input * pricing.inputPer1m +
      usage.output * pricing.outputPer1m +
      usage.cacheRead * pricing.cacheReadPer1m +
      usage.cacheWrite * pricing.cacheWritePer1m) /
    1_000_000
  );
}

export interface SpendRangeOptions {
  start?: number;
  end?: number;
  provider?: string;
  model?: string;
}

export interface SpendSummary {
  start: number;
  end: number;
  requests: number;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  /** Provider prompt-cache tokens read (hits) / written (cache creation). */
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** Requests served from the proxy's own response cache. */
  responseCacheHits: number;
  /** Requests with at least one provider prompt-cache hit + their share. */
  promptCacheHits: number;
  promptCacheHitRate: number;
}

interface SpendRow {
  requests: number;
  cost_usd: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  errors: number;
  avg_latency_ms: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  response_cache_hits: number | null;
  prompt_cache_hits: number | null;
}

/** Aggregated spend for a tenant over [start, end); tenant-scoped by definition. */
export async function spendForRange(
  env: Env,
  organizationId: string,
  options: SpendRangeOptions = {},
): Promise<SpendSummary> {
  const start = options.start ?? nowSeconds() - 24 * 3600;
  const end = options.end ?? nowSeconds();
  const where: string[] = [
    "organization_id = ?",
    "timestamp >= ?",
    "timestamp < ?",
  ];
  const params: (string | number)[] = [organizationId, start, end];
  if (options.provider) {
    where.push("provider = ?");
    params.push(options.provider);
  }
  if (options.model) {
    where.push("model = ?");
    params.push(options.model);
  }

  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS requests,
       SUM(cost_usd) AS cost_usd,
       SUM(tokens_input) AS tokens_input,
       SUM(tokens_output) AS tokens_output,
       SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
       AVG(latency_ms) AS avg_latency_ms,
       SUM(tokens_cache_read) AS tokens_cache_read,
       SUM(tokens_cache_write) AS tokens_cache_write,
       SUM(cache_hit) AS response_cache_hits,
       COUNT(CASE WHEN tokens_cache_read > 0 THEN 1 END) AS prompt_cache_hits
     FROM request_metrics WHERE ${where.join(" AND ")}`,
  )
    .bind(...params)
    .first<SpendRow>();

  const requests = row?.requests ?? 0;
  const errors = row?.errors ?? 0;
  const promptCacheHits = row?.prompt_cache_hits ?? 0;
  return {
    start,
    end,
    requests,
    costUsd: row?.cost_usd ?? 0,
    tokensInput: row?.tokens_input ?? 0,
    tokensOutput: row?.tokens_output ?? 0,
    errors,
    errorRate: requests > 0 ? errors / requests : 0,
    avgLatencyMs: row?.avg_latency_ms ?? 0,
    tokensCacheRead: row?.tokens_cache_read ?? 0,
    tokensCacheWrite: row?.tokens_cache_write ?? 0,
    responseCacheHits: row?.response_cache_hits ?? 0,
    promptCacheHits,
    promptCacheHitRate: requests > 0 ? promptCacheHits / requests : 0,
  };
}

export interface LimitCheck {
  okay: boolean;
  exceeded: "daily" | "monthly" | null;
  usage: number;
  limit: number;
  level: number;
}

/**
 * Evaluate tenant spend limits. `usageFraction` is the current spend divided
 * by the limit for a given window; returns the state for alerting at 80/90/100%.
 */
export function checkSpendLimit(
  limitUsd: number | undefined,
  spentUsd: number,
): LimitCheck | undefined {
  if (!limitUsd || limitUsd <= 0) return undefined;
  const level = spentUsd / limitUsd;
  return {
    okay: spentUsd < limitUsd,
    exceeded: spentUsd >= limitUsd ? "daily" : null,
    usage: spentUsd,
    limit: limitUsd,
    level,
  };
}

/** Aggregate window checks (daily + monthly) against tenant spendLimits. */
export async function spendLimitStatus(
  env: Env,
  settings: TenantSettings,
  organizationId: string,
): Promise<{ daily?: LimitCheck; monthly?: LimitCheck }> {
  const limits = settings.spendLimits;
  const result: { daily?: LimitCheck; monthly?: LimitCheck } = {};
  const now = nowSeconds();

  if (limits?.dailyUsd) {
    const startOfDay = now - (now % 86400);
    const spend = await spendForRange(env, organizationId, {
      start: startOfDay,
      end: now,
    });
    const check = checkSpendLimit(limits.dailyUsd, spend.costUsd);
    if (check)
      result.daily = {
        ...check,
        exceeded: spend.costUsd >= limits.dailyUsd ? "daily" : null,
      };
  }
  if (limits?.monthlyUsd) {
    const startOfMonth = monthStartSeconds(now);
    const spend = await spendForRange(env, organizationId, {
      start: startOfMonth,
      end: now,
    });
    const check = checkSpendLimit(limits.monthlyUsd, spend.costUsd);
    if (check)
      result.monthly = {
        ...check,
        exceeded: spend.costUsd >= limits.monthlyUsd ? "monthly" : null,
      };
  }
  return result;
}

export function monthStartSeconds(now: number): number {
  const d = new Date(now * 1000);
  return Math.floor(
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).getTime() / 1000,
  );
}

export interface DailyCostRow {
  /** Unix timestamp (seconds) at UTC midnight for the day. */
  day: number;
  cost_usd: number;
  requests: number;
}

/** Per-day cost breakout for a tenant (used by GET /usage/costs). */
export async function dailyCosts(
  env: Env,
  organizationId: string,
  start: number,
  end: number,
): Promise<DailyCostRow[]> {
  // `timestamp` is stored as unix seconds; bucket each row to UTC midnight
  // with pure integer math (no date-string round trip).
  const { results } = await env.DB.prepare(
    `SELECT (timestamp / 86400) * 86400 AS day,
       SUM(cost_usd) AS cost_usd, COUNT(*) AS requests
     FROM request_metrics
     WHERE organization_id = ? AND timestamp >= ? AND timestamp < ?
     GROUP BY day ORDER BY day ASC`,
  )
    .bind(organizationId, start, end)
    .all<{ day: number; cost_usd: number; requests: number }>();
  return results.map((r) => ({
    day: r.day,
    cost_usd: r.cost_usd ?? 0,
    requests: r.requests ?? 0,
  }));
}

export interface CacheUsageRow {
  provider: string;
  model: string;
  requests: number;
  tokensInput: number;
  /** Provider prompt-cache hits (tokens served from the provider's cache). */
  tokensCacheRead: number;
  /** Provider prompt-cache writes (tokens written to the provider's cache). */
  tokensCacheWrite: number;
  /** Requests with at least one prompt-cache hit. */
  promptCacheHits: number;
  promptCacheHitRate: number;
  /** Requests served from the proxy's own response cache. */
  responseCacheHits: number;
}

/**
 * Prompt/response cache usage grouped by provider + model over [start, end).
 * `tokensInput` here is uncached input only (cache tokens are reported
 * separately), which makes hit rates and savings directly comparable.
 */
export async function cacheUsageByModel(
  env: Env,
  organizationId: string,
  start: number,
  end: number,
): Promise<CacheUsageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT provider, model,
       COUNT(*) AS requests,
       SUM(tokens_input) AS tokens_input,
       SUM(tokens_cache_read) AS tokens_cache_read,
       SUM(tokens_cache_write) AS tokens_cache_write,
       COUNT(CASE WHEN tokens_cache_read > 0 THEN 1 END) AS prompt_cache_hits,
       SUM(cache_hit) AS response_cache_hits
     FROM request_metrics
     WHERE organization_id = ? AND timestamp >= ? AND timestamp < ?
     GROUP BY provider, model
     ORDER BY requests DESC`,
  )
    .bind(organizationId, start, end)
    .all<{
      provider: string;
      model: string;
      requests: number;
      tokens_input: number | null;
      tokens_cache_read: number | null;
      tokens_cache_write: number | null;
      prompt_cache_hits: number | null;
      response_cache_hits: number | null;
    }>();
  return results.map((r) => {
    const requests = r.requests ?? 0;
    const promptCacheHits = r.prompt_cache_hits ?? 0;
    return {
      provider: r.provider,
      model: r.model,
      requests,
      tokensInput: r.tokens_input ?? 0,
      tokensCacheRead: r.tokens_cache_read ?? 0,
      tokensCacheWrite: r.tokens_cache_write ?? 0,
      promptCacheHits,
      promptCacheHitRate: requests > 0 ? promptCacheHits / requests : 0,
      responseCacheHits: r.response_cache_hits ?? 0,
    };
  });
}
