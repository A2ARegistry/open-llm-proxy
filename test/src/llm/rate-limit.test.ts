import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { checkRateLimits, settleTokenUsage } from "~/src/llm/rate-limit";
import {
  getCachedResponse,
  putCachedResponse,
  responseCacheKey,
} from "~/src/llm/response-cache";

const ORG = "org_rl_test";
const KEY = "key_rl_test";

function settings(rpm?: number, tpm?: number) {
  return {
    rateLimit: {
      requestsPerMinute: rpm,
      tokensPerMinute: tpm,
      burstSize: rpm,
    },
    cache: { enabled: false },
  } as never;
}

describe("checkRateLimits (per-org request bucket)", () => {
  it("allows up to capacity then returns 429 with Retry-After", async () => {
    const first = await checkRateLimits(env as never, {
      organizationId: ORG,
      apiKeyId: KEY,
      settings: settings(2),
    });
    expect(first.allowed).toBe(true);

    const second = await checkRateLimits(env as never, {
      organizationId: ORG,
      apiKeyId: KEY,
      settings: settings(2),
    });
    expect(second.allowed).toBe(true);

    const third = await checkRateLimits(env as never, {
      organizationId: ORG,
      apiKeyId: KEY,
      settings: settings(2),
    });
    expect(third.allowed).toBe(false);
    expect(third.status).toBe(429);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it("is disabled when no RPM is configured", async () => {
    const res = await checkRateLimits(env as never, {
      organizationId: ORG,
      apiKeyId: KEY,
      settings: settings(undefined, 1000),
    });
    expect(res.allowed).toBe(true);
  });
});

describe("token bucket peek + settle", () => {
  it("peek denies when the estimate exceeds the per-minute budget", async () => {
    const res = await checkRateLimits(env as never, {
      organizationId: ORG,
      apiKeyId: KEY,
      settings: settings(undefined, 3),
      estimatedTokens: 5,
    });
    expect(res.allowed).toBe(false);
  });

  it("settles actual tokens and blocks until the bucket refills", async () => {
    await settleTokenUsage(env as never, {
      organizationId: ORG,
      settings: settings(undefined, 10),
      actualTokens: 15,
    });
    const res = await checkRateLimits(env as never, {
      organizationId: ORG,
      apiKeyId: KEY,
      settings: settings(undefined, 10),
      estimatedTokens: 5,
    });
    expect(res.allowed).toBe(false);
  });
});

describe("response cache helpers", () => {
  it("round-trips a value through the ResponseCache DO", async () => {
    const key = await responseCacheKey(ORG, "canonical-json");
    expect(await getCachedResponse(env as never, ORG, key)).toBeNull();

    await putCachedResponse(env as never, ORG, key, "hello-world", 60);
    const value = await getCachedResponse(env as never, ORG, key);
    expect(value).toBe("hello-world");
  });

  it("is orthogonal across tenant shards", async () => {
    const key = await responseCacheKey(ORG, "same-json");
    await putCachedResponse(env as never, ORG, key, "org-a", 60);
    const other = await getCachedResponse(env as never, "org_rl_other", key);
    expect(other).toBeNull();
  });
});
