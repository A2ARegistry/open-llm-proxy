import type { TenantSettings } from "../db/tenant";
import type { ApiKeyScopes } from "../types";

export type PolicyError =
  | { status: 403; code: "tenant_suspended"; message: string }
  | { status: 403; code: "provider_disabled"; message: string }
  | { status: 403; code: "provider_not_allowed"; message: string }
  | { status: 403; code: "model_not_allowed"; message: string };

export function assertTenantActive(
  settings: TenantSettings,
): PolicyError | undefined {
  const status = (settings.status as string | undefined) ?? "active";
  if (status === "suspended") {
    return {
      status: 403,
      code: "tenant_suspended",
      message: "Organization is suspended",
    };
  }
  return undefined;
}

export function assertProviderAllowed(
  settings: TenantSettings,
  scopes: ApiKeyScopes | undefined,
  provider: string,
): PolicyError | undefined {
  if (scopes?.providers && scopes.providers.length > 0) {
    const allowed = scopes.providers.some(
      (p) => p.toLowerCase() === provider.toLowerCase(),
    );
    if (!allowed) {
      return {
        status: 403,
        code: "provider_not_allowed",
        message: `Provider '${provider}' is not allowed for this API key`,
      };
    }
  }
  return undefined;
}

/**
 * A model string ("provider/model" or bare "model") is allowed when all
 * configured allowlists are empty/absent, or when it matches at least one
 * entry. Entries may be provider-qualified ("openai/gpt-4o") or bare.
 */
export function isModelAllowed(
  lists: (string[] | undefined)[],
  provider: string,
  model: string,
): boolean {
  for (const list of lists) {
    if (!list || list.length === 0) continue;
    const matched = list.some((entry) => {
      const slash = entry.indexOf("/");
      if (slash === -1)
        return entry === model || entry === `${provider}/${model}`;
      return entry.toLowerCase() === `${provider}/${model}`.toLowerCase();
    });
    if (!matched) return false;
  }
  return true;
}

export function assertModelAllowed(
  settings: TenantSettings,
  scopes: ApiKeyScopes | undefined,
  provider: string,
  model: string,
): PolicyError | undefined {
  if (
    !isModelAllowed([settings.modelAllowlist, scopes?.models], provider, model)
  ) {
    return {
      status: 403,
      code: "model_not_allowed",
      message: `Model '${provider}/${model}' is not allowed`,
    };
  }
  return undefined;
}
