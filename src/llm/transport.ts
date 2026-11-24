// [fork] Upstream transport selection for OpenAI-compatible providers.
// See FORK.md (W1). Lets a provider reach its upstream through a Worker
// binding (e.g. a Workers VPC service) instead of the global fetch.
import { TransportNotConfiguredError } from "./transport-error";

/** Minimal shape of a Worker binding that can serve HTTP (Fetcher, VPC service). */
export interface UpstreamFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const VPC_PATH_KEYS = ["chatCompletionPath", "modelsPath", "embeddingsPath"];
const VPC_PATH_PREFIX = "/v1/";

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
  let basePath: string;
  try {
    basePath = new URL(String(settings.baseUrl)).pathname;
  } catch {
    throw new TransportNotConfiguredError(
      "settings.baseUrl must be a URL for the vpc transport",
    );
  }
  if (basePath !== "/") {
    throw new TransportNotConfiguredError(
      "settings.baseUrl must not include a path for the vpc transport",
    );
  }
  for (const key of VPC_PATH_KEYS) {
    const path = settings[key];
    if (path === undefined) continue;
    const resolved = new URL(String(path), "http://vpc.invalid").pathname;
    if (!resolved.startsWith(VPC_PATH_PREFIX)) {
      throw new TransportNotConfiguredError(
        `settings.${key} must stay under ${VPC_PATH_PREFIX} for the vpc transport`,
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
