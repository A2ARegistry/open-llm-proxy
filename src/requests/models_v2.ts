import { TenantService } from "../db/tenant";
import { listProviderConfigs } from "../llm/credential-store";
import {
  parseVertexConfig,
  resolveVertexHeaders,
  vertexBaseUrl,
  vertexModelsPath,
} from "../llm/google-vertex";
import {
  builtinModels,
  mergeModels,
  normalizeProviderModelId,
  synthesizedMetadata,
} from "../llm/model-catalog";
import { isModelAllowed } from "../llm/policy";
import {
  V1_PROVIDER_NAMES,
  canonicalProviderName,
  PI_AI_PROVIDER_NAMES,
} from "../llm/provider-registry";
import { V1OpenAICompatibleClient } from "../llm/v1-provider";
import { ApiKeyAuth } from "../types";

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

function entry(
  id: string,
  api: string,
  meta: { contextWindow?: number; maxTokens?: number; cost?: unknown },
): CatalogEntry {
  return { id, api, ...meta };
}

async function fetchJson(
  url: string,
  headers?: Record<string, string>,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
      .map((m) => entry(m.id as string, "openai-completions", {}));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function catalogModels(provider: string): CatalogEntry[] {
  return builtinModels(provider).map((m) =>
    entry(String(m.id ?? ""), String(m.api ?? ""), {
      contextWindow: (m as { contextWindow?: number }).contextWindow,
      maxTokens: (m as { maxTokens?: number }).maxTokens,
      cost: (m as { cost?: unknown }).cost,
    }),
  );
}

/**
 * Google AI Studio: baked catalog + the live model list from the
 * generativelanguage API (falls back to baked on any error).
 */
async function aiStudioModels(cfg: {
  keys: string[];
}): Promise<CatalogEntry[]> {
  const baked = catalogModels("google-ai-studio");
  const key = cfg.keys[0];
  if (!key) return baked;
  const json = await fetchJson(
    "https://generativelanguage.googleapis.com/v1beta/models",
    { "x-goog-api-key": key },
  );
  const list =
    json && Array.isArray((json as { models?: unknown }).models)
      ? (json as { models: { name?: string }[] }).models
      : [];
  const live = list
    .map((m) => m.name)
    .filter((n): n is string => typeof n === "string")
    .map((n) => normalizeProviderModelId(n, "google-ai-studio"))
    .filter((n) => n.length > 0)
    .map((id) => entry(id, "google-generative-ai", synthesizedMetadata(id)));
  return mergeModels(baked, live);
}

/**
 * Google Vertex AI: baked catalog, merged with the live OpenAI-compatible model
 * list for service-account mode and any tenant-pinned custom model ids
 * (Express Mode has no model-list endpoint, so custom ids are the way to list
 * models that aren't in the baked catalog).
 */
async function vertexModels(cfg: {
  keys: string[];
  settings?: Record<string, unknown>;
}): Promise<CatalogEntry[]> {
  const baked = catalogModels("google-vertex");
  const api = baked[0]?.api ?? "google-vertex";

  let live: CatalogEntry[] = [];
  if (cfg.settings?.authMode === "service-account") {
    try {
      const vertex = parseVertexConfig({
        settings: cfg.settings,
        keys: cfg.keys,
      });
      const headers = await resolveVertexHeaders(vertex);
      const url = `${vertexBaseUrl(vertex.settings.location)}${vertexModelsPath(
        vertex.settings.projectId,
        vertex.settings.location,
      )}`;
      const json = await fetchJson(url, headers);
      const data =
        json && Array.isArray((json as { data?: unknown }).data)
          ? (json as { data: { id?: string }[] }).data
          : [];
      live = data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string")
        .map((id) =>
          entry(
            normalizeProviderModelId(id, "google-vertex"),
            "google-vertex",
            synthesizedMetadata(id),
          ),
        );
    } catch {
      live = [];
    }
  }

  const customIds = Array.isArray(cfg.settings?.customModels)
    ? (cfg.settings.customModels as unknown[]).filter(
        (c): c is string => typeof c === "string",
      )
    : [];
  const custom = customIds
    .map((c) => c.trim())
    .filter(Boolean)
    .map((id) => entry(id, api, synthesizedMetadata(id)));

  return mergeModels(baked, mergeModels(live, custom));
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
      if (provider === "google-vertex") {
        models = await vertexModels(cfg);
      } else if (provider === "google-ai-studio") {
        models = await aiStudioModels(cfg);
      } else if (PI_AI_PROVIDER_NAMES.includes(provider)) {
        models = catalogModels(provider);
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
