import { TenantSettings } from "../db/tenant";
import { sha256Hex } from "../utils/crypto";

interface CheckInput {
  key: string;
  capacity: number;
  refillPerMinute: number;
  cost?: number;
  peek?: boolean;
  force?: boolean;
}

export interface RateLimitOutcome {
  allowed: boolean;
  status?: number;
  retryAfter?: number;
  errorMessage?: string;
}

/**
 * Deterministic shard for a tenant: `RATE_LIMITER_SHARDS` (default 4) DO
 * instances, chosen by hash(orgId). A tenant's buckets stay on one shard
 * (correct bucket state) while hot tenants still spread across instances —
 * per the design's hash-sharding requirement.
 */
async function shard(
  env: Env,
  organizationId: string,
): Promise<DurableObjectStub | undefined> {
  const binding = (env as { RATE_LIMITER?: DurableObjectNamespace })
    .RATE_LIMITER;
  if (!binding) return undefined;
  const shards =
    Number((env as { RATE_LIMITER_SHARDS?: string }).RATE_LIMITER_SHARDS) || 4;
  const hash = await sha256Hex(organizationId);
  const n = (BigInt(`0x${hash.slice(0, 16)}`) % BigInt(shards)).toString();
  return binding.get(binding.idFromName(`rl:${n}`));
}

async function doCheck(
  env: Env,
  organizationId: string,
  input: CheckInput,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const stub = await shard(env, organizationId);
  if (!stub) return { allowed: true };
  const res = await stub.fetch("http://internal/check", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (res.status === 429) {
    const body = (await res.json()) as { retryAfterSeconds?: number };
    return { allowed: false, retryAfter: body.retryAfterSeconds };
  }
  return { allowed: true };
}

/**
 * Pre-request rate-limit check against the tenant's RateLimiter shard:
 * per-tenant and per-key request buckets (refill = requestsPerMinute) and,
 * when the caller can estimate token cost (max_tokens), a peek at the token
 * bucket. Returns 429 + Retry-After when a bucket is exhausted.
 */
export async function checkRateLimits(
  env: Env,
  params: {
    organizationId: string;
    apiKeyId: string;
    settings: TenantSettings;
    estimatedTokens?: number;
  },
): Promise<RateLimitOutcome> {
  const rate = params.settings.rateLimit;
  const rpm = rate?.requestsPerMinute;
  const burst = rate?.burstSize ?? rpm ?? 0;
  const tpm = rate?.tokensPerMinute;

  const checks: Promise<{ allowed: boolean; retryAfter?: number }>[] = [];

  if (rpm && rpm > 0) {
    const capacity = Math.max(rpm, burst);
    checks.push(
      doCheck(env, params.organizationId, {
        key: `requests:org:${params.organizationId}`,
        capacity,
        refillPerMinute: rpm,
        cost: 1,
      }),
    );
    checks.push(
      doCheck(env, params.organizationId, {
        key: `requests:key:${params.apiKeyId}`,
        capacity,
        refillPerMinute: rpm,
        cost: 1,
      }),
    );
  }

  const estimated = params.estimatedTokens ?? 0;
  if (tpm && tpm > 0 && estimated > 0) {
    checks.push(
      doCheck(env, params.organizationId, {
        key: `tokens:org:${params.organizationId}`,
        capacity: tpm,
        refillPerMinute: tpm,
        cost: estimated,
        peek: true,
      }),
    );
  }

  if (checks.length === 0) return { allowed: true };

  const results = await Promise.all(checks);
  const denied = results.find((r) => !r.allowed);
  if (denied) {
    return {
      allowed: false,
      status: 429,
      retryAfter: denied.retryAfter,
      errorMessage: "Rate limit exceeded",
    };
  }
  return { allowed: true };
}

/**
 * Post-request token settlement: charge the actual token usage to the tenant
 * token bucket (fire-and-forget from waitUntil). `force` lets the bucket go
 * negative so a burst that overshoots the per-minute budget is still recorded
 * and blocks subsequent requests until it refills.
 */
export async function settleTokenUsage(
  env: Env,
  params: {
    organizationId: string;
    settings: TenantSettings;
    actualTokens: number;
  },
): Promise<void> {
  const tpm = params.settings.rateLimit?.tokensPerMinute;
  if (!tpm || tpm <= 0 || params.actualTokens <= 0) return;
  const stub = await shard(env, params.organizationId);
  if (!stub) return;
  await stub.fetch("http://internal/check", {
    method: "POST",
    body: JSON.stringify({
      key: `tokens:org:${params.organizationId}`,
      capacity: tpm,
      refillPerMinute: tpm,
      cost: params.actualTokens,
      force: true,
    }),
  });
}
