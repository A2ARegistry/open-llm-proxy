import { sha256Hex } from "../utils/crypto";

/**
 * Phase 4.2 — opt-in response cache for non-streaming chat completions.
 * Gated on tenant settings `cache.enabled`. Keys are content-addressed (hash
 * of the canonical request payload), so identical prompts/models collide
 * across tenants only within their own shard (one DO shard per org).
 */
export async function getCachedResponse(
  env: Env,
  organizationId: string,
  cacheKey: string,
): Promise<string | null> {
  const stub = responseCacheStub(env, organizationId);
  if (!stub) return null;
  const res = await stub.fetch(
    `http://internal/get?key=${encodeURIComponent(cacheKey)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`ResponseCache get failed: ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { value?: string };
  return body.value ?? null;
}

export async function putCachedResponse(
  env: Env,
  organizationId: string,
  cacheKey: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  const stub = responseCacheStub(env, organizationId);
  if (!stub) return;
  try {
    await stub.fetch("http://internal/put", {
      method: "POST",
      body: JSON.stringify({ key: cacheKey, value, ttlSeconds }),
    });
  } catch (err) {
    console.error("ResponseCache put failed", err);
  }
}

function responseCacheStub(
  env: Env,
  organizationId: string,
): DurableObjectStub | undefined {
  const binding = (env as { RESPONSE_CACHE?: DurableObjectNamespace })
    .RESPONSE_CACHE;
  if (!binding) return undefined;
  return binding.get(binding.idFromName(`rc:${organizationId}`));
}

/** Content-addressed key from the canonical request payload. */
export async function responseCacheKey(
  organizationId: string,
  canonicalJson: string,
): Promise<string> {
  return `v1:${await sha256Hex(`${organizationId}:${canonicalJson}`)}`;
}
