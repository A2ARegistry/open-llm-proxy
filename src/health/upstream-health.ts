// [fork] W7: health of VPC upstreams (the self-hosted box), checked by cron.
import { vpcBindingNames, type UpstreamFetcher } from "../llm/transport";

const HEALTH_URL = "http://vpc.internal/health";
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_TTL_SECONDS = 3600;

export interface UpstreamHealth {
  binding: string;
  status: "ok" | "down" | "unknown";
  version: string | null;
  checkedAt: number | null;
  latencyMs: number | null;
}

function healthKey(binding: string): string {
  return `health:${binding}`;
}

async function probe(
  binding: UpstreamFetcher | undefined,
): Promise<{ ok: boolean; version: string | null }> {
  if (typeof binding?.fetch !== "function") return { ok: false, version: null };
  try {
    const res = await binding.fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, version: null };
    const body = (await res.json()) as { status?: unknown; version?: unknown };
    return {
      ok: body.status === "ok",
      version: typeof body.version === "string" ? body.version : null,
    };
  } catch {
    return { ok: false, version: null };
  }
}

/** Probe `GET /health` on every configured VPC binding and store the result. */
export async function checkUpstreams(env: Env): Promise<void> {
  const bindings = env as unknown as Record<
    string,
    UpstreamFetcher | undefined
  >;
  await Promise.all(
    vpcBindingNames(env).map(async (name) => {
      const startedAt = Date.now();
      const result = await probe(bindings[name]);
      const entry: UpstreamHealth = {
        binding: name,
        status: result.ok ? "ok" : "down",
        version: result.version,
        checkedAt: Math.floor(startedAt / 1000),
        latencyMs: Date.now() - startedAt,
      };
      await env.SESSION_CACHE.put(healthKey(name), JSON.stringify(entry), {
        expirationTtl: HEALTH_TTL_SECONDS,
      });
    }),
  );
}

/** Last stored health for the VPC bindings `organizationId` may use. */
export async function readUpstreamHealth(
  env: Env,
  organizationId: string,
): Promise<UpstreamHealth[]> {
  return Promise.all(
    vpcBindingNames(env, organizationId).map(async (name) => {
      const stored = await env.SESSION_CACHE.get<UpstreamHealth>(
        healthKey(name),
        "json",
      );
      return (
        stored ?? {
          binding: name,
          status: "unknown",
          version: null,
          checkedAt: null,
          latencyMs: null,
        }
      );
    }),
  );
}
