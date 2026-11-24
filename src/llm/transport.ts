// [fork] Upstream transport selection for OpenAI-compatible providers.
// See FORK.md (W1). Lets a provider reach its upstream through a Worker
// binding (e.g. a Workers VPC service) instead of the global fetch.
import { TransportNotConfiguredError } from "./transport-error";

/** Minimal shape of a Worker binding that can serve HTTP (Fetcher, VPC service). */
export interface UpstreamFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Resolve the fetcher for a provider's settings.
 *
 * - `transport` unset or `"public"`: returns `undefined` (use global fetch).
 * - `transport: "vpc"`: returns `env[settings.vpcBinding]`, but only when that
 *   name is listed in the comma-separated `VPC_BINDINGS` allowlist, so a
 *   dashboard admin cannot point a provider at arbitrary Worker bindings.
 *
 * @throws TransportNotConfiguredError when a vpc transport cannot be resolved.
 */
export function resolveFetcher(
  env: object,
  settings: Record<string, unknown> | undefined,
): UpstreamFetcher | undefined {
  if (settings?.transport !== "vpc") return undefined;

  const name = settings.vpcBinding;
  if (typeof name !== "string" || !name) {
    throw new TransportNotConfiguredError(
      "settings.vpcBinding is required when transport is vpc",
    );
  }

  const bindings = env as Record<string, unknown>;
  const allowlist = String(bindings.VPC_BINDINGS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!allowlist.includes(name)) {
    throw new TransportNotConfiguredError(
      `VPC binding ${name} is not allowed by VPC_BINDINGS`,
    );
  }

  const binding = bindings[name] as Partial<UpstreamFetcher> | undefined;
  if (typeof binding?.fetch !== "function") {
    throw new TransportNotConfiguredError(
      `VPC binding ${name} is not bound to this Worker`,
    );
  }
  return binding as UpstreamFetcher;
}
