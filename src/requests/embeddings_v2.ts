import { getProviderConfig } from "../llm/credential-store";
import { resolveDefaultModel } from "../llm/model-catalog";
import {
  assertModelAllowed,
  assertProviderAllowed,
  assertTenantActive,
} from "../llm/policy";
import {
  canonicalProviderName,
  isOpenAICompatibleProvider,
} from "../llm/provider-registry";
import { V1OpenAICompatibleClient } from "../llm/v1-provider";
import { TenantService } from "../db/tenant";
import { ApiKeyAuth } from "../types";

export interface EmbeddingsInput {
  request: Request;
  env: Env;
  apiKeyAuth: ApiKeyAuth;
}

export async function embeddingsV2(input: EmbeddingsInput): Promise<Response> {
  const { request, env, apiKeyAuth } = input;
  const organizationId = apiKeyAuth.organizationId;
  const settings = await new TenantService(env.DB).getSettings(organizationId);
  const blocked = assertTenantActive(settings);
  if (blocked) return errorBody(blocked.code, blocked.message);

  let body: { model?: unknown; input?: unknown };
  try {
    body = (await request.json()) as { model?: unknown; input?: unknown };
  } catch {
    return errorBody("invalid_request_error", "Invalid request body");
  }
  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  if (!rawModel) return errorBody("invalid_request_error", "model is required");
  const slash = rawModel.indexOf("/");
  const boundProvider = apiKeyAuth.scopes.defaultProvider
    ? canonicalProviderName(apiKeyAuth.scopes.defaultProvider)
    : undefined;
  const provider = canonicalProviderName(
    slash > 0 ? rawModel.slice(0, slash) : boundProvider ?? "",
  );
  const model = slash > 0 ? rawModel.slice(slash + 1) : rawModel;
  if (!provider || !model) {
    return errorBody("invalid_request_error", "model must be provider/model");
  }
  const providerError = assertProviderAllowed(settings, apiKeyAuth.scopes, provider);
  if (providerError) return errorBody(providerError.code, providerError.message);
  const config = await getProviderConfig(env, organizationId, provider);
  if (!config) return errorBody("not_configured", `Provider '${provider}' is not configured`);
  if (!config.enabled) return errorBody("provider_disabled", `Provider '${provider}' is disabled`);
  if (!isOpenAICompatibleProvider(provider)) {
    return errorBody("unsupported_provider", `Provider '${provider}' does not support OpenAI embeddings`);
  }
  const resolvedModel = model || resolveDefaultModel(config.settings, provider);
  if (!resolvedModel) return errorBody("not_configured", `Provider '${provider}' has no default model configured`);
  const modelError = assertModelAllowed(settings, apiKeyAuth.scopes, provider, resolvedModel);
  if (modelError) return errorBody(modelError.code, modelError.message);

  const client = new V1OpenAICompatibleClient({
    provider,
    keys: config.keys,
    rotationStrategy: config.settings.rotationStrategy,
    custom:
      config.settings.baseUrl || config.settings.accountId
        ? {
            baseUrl: config.settings.baseUrl as string | undefined,
            accountId: config.settings.accountId as string | undefined,
            embeddingsPath: config.settings.embeddingsPath as string | undefined,
          }
        : undefined,
  });
  let upstream: Response;
  try {
    upstream = await client.embeddings(
      JSON.stringify({ ...body, model: resolvedModel }),
      { signal: request.signal },
    );
  } catch (error) {
    return errorBody("upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return errorBody("upstream_error", `Upstream error (${upstream.status}): ${text.slice(0, 512)}`);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

function errorBody(code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: code, code } }), {
    status: code === "upstream_error" ? 502 : 400,
    headers: { "Content-Type": "application/json" },
  });
}
