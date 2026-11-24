// [fork] W11: where the live monitor reads from, and how.
// Inference metrics come from a VPC_BINDINGS binding the org may use; host
// metrics from a separate HOST_METRICS_BINDINGS allowlist that providers and
// the health cron never see. Only fixed GET paths are fetched, with a short
// timeout, so a slow box cannot hold the dashboard request open.
import {
  isAllowed,
  parseAllowlist,
  vpcBindingNames,
  type UpstreamFetcher,
} from "../llm/transport";

export const LIVE_TIMEOUT_MS = 2000;

const LIVE_ORIGIN = "http://vpc.internal";

export interface LiveBinding {
  name: string;
  fetcher: UpstreamFetcher;
}

/** Binding names in `HOST_METRICS_BINDINGS`, optionally only those `organizationId` may use. */
export function hostMetricsBindingNames(
  env: object,
  organizationId?: string,
): string[] {
  const allowlist = parseAllowlist(
    (env as Record<string, unknown>).HOST_METRICS_BINDINGS,
  );
  return [...allowlist.keys()].filter(
    (name) =>
      name !== "" &&
      (organizationId === undefined ||
        isAllowed(allowlist, name, organizationId)),
  );
}

function firstBound(env: object, names: string[]): LiveBinding | null {
  const bindings = env as Record<string, Partial<UpstreamFetcher> | undefined>;
  for (const name of names) {
    const binding = bindings[name];
    if (typeof binding?.fetch === "function") {
      return { name, fetcher: binding as UpstreamFetcher };
    }
  }
  return null;
}

/** First bound VPC binding (the inference server) that `organizationId` may use. */
export function inferenceBinding(
  env: object,
  organizationId: string,
): LiveBinding | null {
  return firstBound(env, vpcBindingNames(env, organizationId));
}

/** First bound host-metrics binding that `organizationId` may use. */
export function hostBinding(
  env: object,
  organizationId: string,
): LiveBinding | null {
  return firstBound(env, hostMetricsBindingNames(env, organizationId));
}

/** GET a fixed path through `fetcher`; null on non-2xx, network error or timeout. */
export async function fetchLiveText(
  fetcher: UpstreamFetcher,
  path: "/health" | "/metrics",
): Promise<string | null> {
  try {
    const res = await fetcher.fetch(`${LIVE_ORIGIN}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
