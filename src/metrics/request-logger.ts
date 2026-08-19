import { pushMetric, MetricDraft } from "./collector";
import { computeCostUsd, getModelPricing, TokenUsage } from "./cost-tracker";

export interface ChatAttempt {
  organizationId: string;
  apiKeyId: string | null;
  startedAt: number;
  provider: string;
  model: string;
  method: "chat";
}

const EMPTY_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Records one LLM chat attempt. `usage` may carry token counts and/or a direct
 * cost; when cost is absent we estimate it against the pricing table. Fire
 * off without awaiting (caller uses ctx.waitUntil) to keep latency to <5ms.
 */
export async function recordChatRequest(
  env: Env,
  attempt: ChatAttempt,
  outcome: {
    statusCode: number;
    usage?: TokenUsage | null;
    costUsd?: number | null;
    errorMessage?: string | null;
    cacheHit?: number;
  },
): Promise<void> {
  const usage = outcome.usage ?? EMPTY_USAGE;
  const elapsedMs = Date.now() - attempt.startedAt;
  let costUsd = outcome.costUsd ?? null;
  if (costUsd === null && (usage.input > 0 || usage.output > 0)) {
    const pricing = await getModelPricing(env, attempt.provider, attempt.model);
    costUsd = computeCostUsd(pricing, usage);
  }

  const draft: MetricDraft = {
    organization_id: attempt.organizationId,
    api_key_id: attempt.apiKeyId,
    provider: attempt.provider,
    model: attempt.model,
    method: attempt.method,
    status_code: outcome.statusCode,
    latency_ms: Math.max(elapsedMs, 0),
    cache_hit: outcome.cacheHit ?? 0,
    tokens_input: usage.input > 0 ? usage.input : null,
    tokens_output: usage.output > 0 ? usage.output : null,
    tokens_cached:
      usage.cacheRead + usage.cacheWrite > 0
        ? usage.cacheRead + usage.cacheWrite
        : null,
    cost_usd: costUsd,
    error_message: outcome.errorMessage ?? null,
  };
  await pushMetric(env, draft);
}
