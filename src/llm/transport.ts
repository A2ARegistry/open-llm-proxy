// [fork] Upstream transport selection for OpenAI-compatible providers.
// See FORK.md (W1). Lets a provider reach its upstream through a Worker
// binding (e.g. a Workers VPC service) instead of the global fetch.
import { TransportNotConfiguredError } from "./transport-error";

/** Minimal shape of a Worker binding that can serve HTTP (Fetcher, VPC service). */
export interface UpstreamFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The only upstream endpoints a vpc provider may reach, by settings key. */
const VPC_PATHS: Record<string, string> = {
  chatCompletionPath: "/v1/chat/completions",
  modelsPath: "/v1/models",
  embeddingsPath: "/v1/embeddings",
};
const VPC_ALLOWED_PATHS = new Set(Object.values(VPC_PATHS));

/**
 * Throw unless `url` is exactly one of the allowed `/v1/` endpoints, with no
 * query, fragment or credentials. Checked on the final URL right before each
 * vpc fetch, so it holds whatever path fallbacks produced it.
 */
export function assertVpcUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportNotConfiguredError("VPC upstream URL is not valid");
  }
  if (
    !VPC_ALLOWED_PATHS.has(parsed.pathname) ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new TransportNotConfiguredError(
      `VPC upstream path ${parsed.pathname} is not allowed`,
    );
  }
}

/**
 * Parse `VPC_BINDINGS` into binding name → allowed organization ids.
 *
 * Format: comma-separated `NAME:org_a|org_b` entries; `NAME:*` allows every
 * organization. A bare `NAME` allows nobody (fail closed).
 */
function parseAllowlist(raw: unknown): Map<string, string[]> {
  const allowlist = new Map<string, string[]>();
  for (const entry of String(raw ?? "").split(",")) {
    const [name, orgs = ""] = entry.trim().split(":");
    allowlist.set(
      name,
      orgs
        .split("|")
        .map((org) => org.trim())
        .filter(Boolean),
    );
  }
  return allowlist;
}

function isAllowed(
  allowlist: Map<string, string[]>,
  name: string,
  organizationId: string,
): boolean {
  const orgs = allowlist.get(name) ?? [];
  return orgs.includes("*") || orgs.includes(organizationId);
}

/** The private host is fixed by the binding; only its OpenAI API is reachable. */
function assertVpcTarget(settings: Record<string, unknown>): void {
  let base: URL;
  try {
    base = new URL(String(settings.baseUrl));
  } catch {
    throw new TransportNotConfiguredError(
      "settings.baseUrl must be a URL for the vpc transport",
    );
  }
  if (
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new TransportNotConfiguredError(
      "settings.baseUrl must be scheme://host:port only for the vpc transport",
    );
  }
  for (const [key, allowed] of Object.entries(VPC_PATHS)) {
    const path = settings[key];
    if (path !== undefined && path !== allowed) {
      throw new TransportNotConfiguredError(
        `settings.${key} must be ${allowed} for the vpc transport`,
      );
    }
  }
}

/**
 * Resolve the fetcher for a provider's settings.
 *
 * - `transport` unset or `"public"`: returns `undefined` (use global fetch).
 * - `transport: "vpc"`: returns `env[settings.vpcBinding]`, but only when
 *   `VPC_BINDINGS` lists that binding for `organizationId`, and the provider
 *   targets only the upstream's `/v1/` API. This stops a dashboard admin from
 *   reaching arbitrary Worker bindings, another tenant's private host, or
 *   non-API paths on it.
 *
 * @throws TransportNotConfiguredError when a vpc transport cannot be resolved.
 */
export function resolveFetcher(
  env: object,
  settings: Record<string, unknown> | undefined,
  organizationId: string,
): UpstreamFetcher | undefined {
  if (settings?.transport !== "vpc") return undefined;

  const name = settings.vpcBinding;
  if (typeof name !== "string" || !name) {
    throw new TransportNotConfiguredError(
      "settings.vpcBinding is required when transport is vpc",
    );
  }

  const bindings = env as Record<string, unknown>;
  if (!isAllowed(parseAllowlist(bindings.VPC_BINDINGS), name, organizationId)) {
    throw new TransportNotConfiguredError(
      `VPC binding ${name} is not allowed for this organization by VPC_BINDINGS`,
    );
  }

  assertVpcTarget(settings);

  const binding = bindings[name] as Partial<UpstreamFetcher> | undefined;
  if (typeof binding?.fetch !== "function") {
    throw new TransportNotConfiguredError(
      `VPC binding ${name} is not bound to this Worker`,
    );
  }
  return binding as UpstreamFetcher;
}

/**
 * [fork] W6: providers on a private transport carry confidential traffic, so
 * content-retaining features (response cache, traces) are forced off for them.
 */
export function isPrivateTransport(
  settings: Record<string, unknown> | undefined,
): boolean {
  return settings?.transport === "vpc";
}
