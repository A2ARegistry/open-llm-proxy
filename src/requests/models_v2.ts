import { TenantService } from "../db/tenant";
import { listProviderConfigs } from "../llm/credential-store";
import { isModelAllowed } from "../llm/policy";
import {
  V1_PROVIDER_NAMES,
  canonicalProviderName,
  PI_AI_PROVIDER_NAMES,
} from "../llm/provider-registry";
import { V1OpenAICompatibleClient } from "../llm/v1-provider";
import { ApiKeyAuth } from "../types";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

interface ModelsInput {
  env: Env;
  apiKeyAuth: ApiKeyAuth;
}

const PROVIDER_FETCH_TIMEOUT_MS = 5000;

interface CatalogEntry {
  id: string;
  api: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: unknown;
  [key: string]: unknown;
}

async function fetchV1Models(
  provider: string,
  keys: string[],
  settings: {
    baseUrl?: string;
    chatCompletionPath?: string;
    modelsPath?: string;
  },
): Promise<CatalogEntry[]> {
  const client = new V1OpenAICompatibleClient({
    provider,
    keys,
    custom: settings.baseUrl
      ? {
          baseUrl: settings.baseUrl,
          chatCompletionPath: settings.chatCompletionPath,
          modelsPath: settings.modelsPath,
        }
      : undefined,
  });
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(),
    PROVIDER_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await client.models({ signal: abortController.signal });
    if (!response.ok) return [];
    const data = (await response.json()) as { data?: { id?: string }[] };
    return (data.data ?? [])
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id as string, api: "openai-completions" }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function piBuiltinModels(provider: string): CatalogEntry[] {
  try {
    return getBuiltinModels(
      provider as Parameters<typeof getBuiltinModels>[0],
    ).map((m) => ({
      id: m.id,
      api: m.api,
      contextWindow: (m as { contextWindow?: number }).contextWindow,
      maxTokens: (m as { maxTokens?: number }).maxTokens,
      cost: (m as { cost?: unknown }).cost,
    }));
  } catch {
    return [];
  }
}

export async function modelsV2(input: ModelsInput): Promise<Response> {
  const { env, apiKeyAuth } = input;
  const organizationId = apiKeyAuth.organizationId;
  const tenants = new TenantService(env.DB);
  const settings = await tenants.getSettings(organizationId);

  const configs = await listProviderConfigs(env, organizationId);
  const enabled = configs.filter((c) => c.enabled);
  const results: { provider: string; models: CatalogEntry[] }[] = [];
  const allowlist = [settings.modelAllowlist, apiKeyAuth.scopes?.models];

  await Promise.all(
    enabled.map(async (cfg) => {
      const provider = canonicalProviderName(cfg.provider);
      let models: CatalogEntry[] = [];
      if (PI_AI_PROVIDER_NAMES.includes(provider)) {
        models = piBuiltinModels(provider);
      } else if (V1_PROVIDER_NAMES.includes(provider)) {
        models = await fetchV1Models(provider, cfg.keys, cfg.settings);
      }
      // api key may pin providers already (provider scope only allows some), but
      // the request must reflect the *effective* list for this key.
      if (
        apiKeyAuth.scopes?.providers &&
        !apiKeyAuth.scopes.providers.includes(provider)
      ) {
        return;
      }
      models = models.filter((m) => {
        const bare = m.id;
        return isModelAllowed(allowlist, provider, bare);
      });
      results.push({ provider, models });
    }),
  );

  const data = results.flatMap(({ provider, models }) =>
    models.map((m) => ({
      id: `${provider}/${m.id}`,
      object: "model",
      created: 0,
      owned_by: provider,
      api: m.api,
      context_window: m.contextWindow,
      max_tokens: m.maxTokens,
    })),
  );

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json" },
  });
}
