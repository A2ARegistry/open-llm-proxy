import type { BufferedMetric } from "../durable/metrics-buffer";
import { newUuid, nowSeconds } from "../utils/crypto";

export interface MetricDraft {
  organization_id: string;
  api_key_id?: string | null;
  timestamp?: number;
  provider: string;
  model: string;
  method: string;
  status_code: number;
  latency_ms: number;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_cached?: number | null;
  cost_usd?: number | null;
  error_message?: string | null;
  cache_hit?: number;
}

function normalize(draft: MetricDraft): BufferedMetric {
  return {
    organization_id: draft.organization_id,
    api_key_id: draft.api_key_id ?? null,
    timestamp: draft.timestamp ?? nowSeconds(),
    provider: draft.provider,
    model: draft.model,
    method: draft.method,
    status_code: draft.status_code,
    latency_ms: draft.latency_ms,
    tokens_input: draft.tokens_input ?? null,
    tokens_output: draft.tokens_output ?? null,
    tokens_cached: draft.tokens_cached ?? null,
    cost_usd: draft.cost_usd ?? null,
    error_message: draft.error_message ?? null,
    cache_hit: draft.cache_hit ?? 0,
  };
}

async function insertDirect(env: Env, row: BufferedMetric): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO request_metrics
      (id, organization_id, user_id, api_key_id, timestamp, provider, model, method,
       status_code, latency_ms, tokens_input, tokens_output, tokens_cached,
       cost_usd, error_message, cache_hit)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `${row.organization_id}_${newUuid().replace(/-/g, "")}`,
      row.organization_id,
      row.api_key_id,
      row.timestamp,
      row.provider,
      row.model,
      row.method,
      row.status_code,
      row.latency_ms,
      row.tokens_input,
      row.tokens_output,
      row.tokens_cached,
      row.cost_usd,
      row.error_message,
      row.cache_hit,
    )
    .run();
}

/**
 * Persist one metric row via the per-tenant MetricsBuffer DO (survives
 * eviction, batched flush to D1). Falls back to a direct D1 insert when the
 * DO binding is missing or the push fails, so a metrics outage never breaks
 * the LLM path.
 */
export async function pushMetric(env: Env, draft: MetricDraft): Promise<void> {
  const row = normalize(draft);
  const buffer = (env as { METRICS_BUFFER?: DurableObjectNamespace })
    .METRICS_BUFFER;
  if (buffer) {
    try {
      const stub = buffer.get(buffer.idFromName(`org:${row.organization_id}`));
      const res = await stub.fetch("http://internal/push", {
        method: "POST",
        body: JSON.stringify({ entries: [row] }),
      });
      if (!res.ok) throw new Error(`metrics buffer push failed: ${res.status}`);
      return;
    } catch (err) {
      console.error(
        "MetricsBuffer push failed, falling back to direct D1",
        err,
      );
    }
  }
  await insertDirect(env, row);
}

/** Direct D1 fallback used when a tenant has no DO shard mounted (tests/dev). */
export { insertDirect as pushMetricDirect };
