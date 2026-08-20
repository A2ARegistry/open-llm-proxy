import { TenantService } from "../db/tenant";
import { getProviderConfig } from "../llm/credential-store";
import {
  isVertexProvider,
  parseVertexConfig,
  resolveVertexHeaders,
  vertexBaseUrl,
  vertexChatCompletionsPath,
  vertexModelsPath,
  vertexModelId,
} from "../llm/google-vertex";
import { resolveDefaultModel } from "../llm/model-catalog";
import { createTenantModels, modelFor } from "../llm/models-factory";
import {
  assistantToOpenAI,
  encodeSse,
  eventToOpenAIChunks,
  resolveRequestModel,
  toPiContext,
} from "../llm/openai-adapter";
import {
  assertModelAllowed,
  assertProviderAllowed,
  assertTenantActive,
} from "../llm/policy";
import {
  canonicalProviderName,
  getPiAiProviderSpec,
  providerApiId,
} from "../llm/provider-registry";
import { checkRateLimits, settleTokenUsage } from "../llm/rate-limit";
import {
  getCachedResponse,
  putCachedResponse,
  responseCacheKey,
} from "../llm/response-cache";
import { V1OpenAICompatibleClient } from "../llm/v1-provider";
import type { TokenUsage } from "../metrics/cost-tracker";
import { recordChatRequest } from "../metrics/request-logger";
import { maybeDisableAfterSpend } from "../metrics/spend-guard";
import { ApiKeyAuth } from "../types";
import type { AssistantMessage } from "@earendil-works/pi-ai";

interface ChatCompletionsInput {
  request: Request;
  env: Env;
  apiKeyAuth: ApiKeyAuth;
  ctx: { waitUntil(promise: Promise<unknown>): void };
}

interface ChatCompletionsRequest {
  model?: string;
  messages?: {
    role: string;
    content?: string | unknown[];
    tool_call_id?: string;
    tool_calls?: {
      id: string;
      function: { name: string; arguments: string };
    }[];
    name?: string;
  }[];
  system_prompt?: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  [key: string]: unknown;
}

function errorBody(code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error", param: null, code },
    }),
    {
      status:
        code === "not_configured"
          ? 400
          : code === "spend_limit_exceeded"
            ? 402
            : 403,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberParam(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export async function chatCompletionsV2(
  input: ChatCompletionsInput,
): Promise<Response> {
  const { env, apiKeyAuth, request, ctx } = input;
  const organizationId = apiKeyAuth.organizationId;

  const tenants = new TenantService(env.DB);
  const settings = await tenants.getSettings(organizationId);

  const tenantBlocked = assertTenantActive(settings);
  if (tenantBlocked)
    return errorBody(tenantBlocked.code, tenantBlocked.message);

  const sbDisabledUntil = apiKeyAuth.spendDisabledUntil;
  const tenantSpendDisabledUntil = settings.spendDisabledUntil as
    number | undefined;
  if (sbDisabledUntil && Date.now() / 1000 < sbDisabledUntil) {
    return errorBody("spend_limit_exceeded", "API key spend cap reached");
  }
  if (
    tenantSpendDisabledUntil &&
    Date.now() / 1000 < tenantSpendDisabledUntil
  ) {
    return errorBody("spend_limit_exceeded", "Tenant spend limit reached");
  }

  const body = parseBody(await request.text());
  if (!body) {
    return errorBody("invalid_model", "Invalid request body");
  }
  const chatBody = body as unknown as ChatCompletionsRequest;

  const resolvedModel = resolveRequestModel({
    rawModel: typeof body.model === "string" ? (body.model as string) : "",
    tenantDefaultModel:
      typeof settings.defaultModel === "string"
        ? settings.defaultModel
        : undefined,
  });
  const providerName = canonicalProviderName(resolvedModel.provider);
  let modelId = resolvedModel.model;

  if (!providerName) {
    return errorBody(
      "not_configured",
      "Model must be formatted as 'provider/model' (or set a tenant default model)",
    );
  }

  const scoped = assertProviderAllowed(
    settings,
    apiKeyAuth.scopes,
    providerName,
  );
  if (scoped) return errorBody(scoped.code, scoped.message);

  const config = await getProviderConfig(env, organizationId, providerName);
  if (!config) {
    return errorBody(
      "not_configured",
      `Provider '${providerName}' is not configured`,
    );
  }
  if (!config.enabled) {
    return errorBody(
      "provider_disabled",
      `Provider '${providerName}' is disabled`,
    );
  }
  if (config.keys.length === 0) {
    return errorBody(
      "not_configured",
      `Provider '${providerName}' has no API keys configured`,
    );
  }

  // A missing/partial model id falls back to the provider's default model
  // (tenant-configured `settings.defaultModel` or the built-in per-provider
  // default), so `model: "openai"`, `model: "openai/"` or a missing model all
  // resolve to a real upstream model id.
  if (!modelId) {
    const providerDefault = resolveDefaultModel(config.settings, providerName);
    if (!providerDefault) {
      return errorBody(
        "not_configured",
        `Provider '${providerName}' has no default model configured`,
      );
    }
    modelId = providerDefault;
  }
  const modelBlocked = assertModelAllowed(
    settings,
    apiKeyAuth.scopes,
    providerName,
    modelId,
  );
  if (modelBlocked) return errorBody(modelBlocked.code, modelBlocked.message);

  const stream = chatBody.stream === true;
  const signal = request.signal;
  // Google Vertex AI in "api-key" mode is Express Mode: no project/location, and
  // requests go through the pi-ai @google/genai adapter (native generateContent).
  // "service-account" mode keeps the OpenAI-compatible endpoint + OAuth2 path.
  const vertexOpenAiCompat =
    isVertexProvider(providerName) &&
    config.settings?.authMode === "service-account";
  const piSpec = getPiAiProviderSpec(providerName);

  const maxTokens = numberParam(
    chatBody.max_tokens ?? chatBody.max_completion_tokens,
  );
  const estimatedTokens = maxTokens ?? 0;

  // Phase 4.1 — per-tenant/per-key rate limits (429 + Retry-After).
  const rate = await checkRateLimits(env, {
    organizationId,
    apiKeyId: apiKeyAuth.keyId,
    settings,
    estimatedTokens,
  });
  if (!rate.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: "Rate limit exceeded. Please retry later.",
          type: "rate_limit_error",
          param: null,
          code: "rate_limit_exceeded",
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(rate.retryAfter ?? 1),
        },
      },
    );
  }

  // Phase 4.2 — opt-in response cache for non-streaming requests.
  const cacheSettings = settings.cache;
  const cacheEnabled = !stream && cacheSettings?.enabled === true;
  const cacheTtl = cacheSettings?.ttl ?? 3600;
  const cacheKey =
    cacheEnabled && chatBody.messages
      ? await responseCacheKey(organizationId, stableStringify(chatBody))
      : null;

  const attempt = {
    organizationId,
    apiKeyId: apiKeyAuth.keyId,
    startedAt: Date.now(),
    provider: providerName,
    model: modelId,
    method: "chat" as const,
  };
  const record = (outcome: {
    statusCode: number;
    usage?: TokenUsage | null;
    costUsd?: number | null;
    errorMessage?: string | null;
    cacheHit?: number;
  }) => {
    ctx.waitUntil(
      recordChatRequest(env, attempt, outcome).catch((err) =>
        console.error("failed to record chat metrics", err),
      ),
    );
    // Post-check: after a paid request, auto-disable the tenant/key when a
    // spend limit or lifetime key cap was just crossed (background, no latency).
    if (outcome.statusCode < 400 && (outcome.costUsd ?? 0) > 0) {
      ctx.waitUntil(
        maybeDisableAfterSpend(
          env,
          organizationId,
          apiKeyAuth.keyId,
          apiKeyAuth.scopes,
        ).catch((err) => console.error("failed to evaluate spend limits", err)),
      );
    }
    // Charge actual tokens to the per-minute token bucket (background).
    if (outcome.statusCode < 400 && outcome.usage) {
      const actualTokens =
        outcome.usage.input + outcome.usage.output + outcome.usage.cacheRead;
      ctx.waitUntil(
        settleTokenUsage(env, {
          organizationId,
          settings,
          actualTokens,
        }).catch((err) => console.error("failed to settle token usage", err)),
      );
    }
  };

  if (piSpec && !vertexOpenAiCompat) {
    const models = createTenantModels({
      env,
      organizationId,
      enabledProviders: [providerName],
    });
    const piModel = modelFor(
      providerName,
      modelId,
      providerApiId(providerName),
    );
    const context = toPiContext(chatBody);
    const options: Record<string, unknown> = { signal };
    const temperature = numberParam(chatBody.temperature);
    if (temperature !== undefined) options.temperature = temperature;
    if (maxTokens !== undefined) options.maxTokens = maxTokens;
    if (
      typeof chatBody.top_p === "number" ||
      typeof chatBody.presence_penalty === "number" ||
      typeof chatBody.frequency_penalty === "number"
    ) {
      options.samplingParams = {
        ...(typeof chatBody.top_p === "number"
          ? { top_p: chatBody.top_p }
          : {}),
        ...(typeof chatBody.presence_penalty === "number"
          ? { presence_penalty: chatBody.presence_penalty }
          : {}),
        ...(typeof chatBody.frequency_penalty === "number"
          ? { frequency_penalty: chatBody.frequency_penalty }
          : {}),
      };
    }

    if (!stream) {
      if (cacheKey) {
        const cached = await getCachedResponse(env, organizationId, cacheKey);
        if (cached !== null) {
          record({ statusCode: 200, cacheHit: 1 });
          return new Response(cached, {
            headers: {
              "Content-Type": "application/json",
              "X-Cache": "HIT",
            },
          });
        }
      }

      let message: AssistantMessage;
      try {
        message = await models.complete({
          model: piModel,
          context,
          signal,
        });
      } catch (err) {
        record({
          statusCode: 500,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        record({
          statusCode: 403,
          usage: usageOf(message),
          costUsd: message.usage?.cost?.total ?? null,
          errorMessage: message.errorMessage ?? "Upstream provider error",
        });
        return errorBody(
          "upstream_error",
          message.errorMessage ?? "Upstream provider error",
        );
      }
      record({
        statusCode: 200,
        usage: usageOf(message),
        costUsd: message.usage?.cost?.total ?? null,
      });
      const bodyText = JSON.stringify(
        assistantToOpenAI(message, chatBody.model as string),
      );
      if (cacheKey) {
        ctx.waitUntil(
          putCachedResponse(env, organizationId, cacheKey, bodyText, cacheTtl),
        );
      }
      return new Response(bodyText, {
        headers: { "Content-Type": "application/json" },
      });
    }

    const chunks: string[] = [];
    const state = { emittedRole: false };
    const responseId = `chatcmpl-${Math.random().toString(36).slice(2)}`;
    let finalMessage: AssistantMessage | undefined;
    try {
      for await (const event of models.stream({
        model: piModel,
        context,
        signal,
      })) {
        if (event.type === "done") finalMessage = event.message;
        if (event.type === "error") finalMessage = event.error;
        for (const chunk of eventToOpenAIChunks(
          event,
          chatBody.model as string,
          responseId,
          state,
        )) {
          chunks.push(chunk);
        }
      }
    } catch (err) {
      record({
        statusCode: 500,
        usage: finalMessage ? usageOf(finalMessage) : null,
        costUsd: finalMessage?.usage?.cost?.total ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    record({
      statusCode: 200,
      usage: finalMessage ? usageOf(finalMessage) : null,
      costUsd: finalMessage?.usage?.cost?.total ?? null,
      errorMessage:
        finalMessage?.stopReason === "error"
          ? (finalMessage.errorMessage ?? "Stream ended with an error")
          : null,
    });
    return new Response(encodeSse(chunks), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // V1 fallback (Ollama, Cohere, Perplexity, custom OpenAI-compatible endpoints)
  // and Google Vertex AI (OpenAI-compatible endpoint with custom auth).
  let client: V1OpenAICompatibleClient;
  let upstreamModelId = modelId;
  if (isVertexProvider(providerName)) {
    let vertexAuth: Record<string, string>;
    try {
      const vertex = parseVertexConfig({
        settings: config.settings,
        keys: config.keys,
      });
      vertexAuth = await resolveVertexHeaders(vertex);
      upstreamModelId = vertexModelId(modelId);
      client = new V1OpenAICompatibleClient({
        provider: providerName,
        baseUrl: vertexBaseUrl(vertex.settings.location),
        chatCompletionPath: vertexChatCompletionsPath(
          vertex.settings.projectId,
          vertex.settings.location,
        ),
        modelsPath: vertexModelsPath(
          vertex.settings.projectId,
          vertex.settings.location,
        ),
        keys: config.keys,
        authHeaders: vertexAuth,
      });
    } catch (err) {
      return errorBody(
        "not_configured",
        err instanceof Error ? err.message : "Vertex AI is not configured",
      );
    }
  } else {
    client = new V1OpenAICompatibleClient({
      provider: providerName,
      keys: config.keys,
      custom: config.settings?.baseUrl
        ? {
            baseUrl: config.settings.baseUrl as string,
            chatCompletionPath: config.settings.chatCompletionPath as
              string | undefined,
            modelsPath: config.settings.modelsPath as string | undefined,
          }
        : undefined,
    });
  }
  const upstreamBody = JSON.stringify({
    ...chatBody,
    model: upstreamModelId,
    stream,
    ...(numberParam(chatBody.temperature) !== undefined
      ? { temperature: chatBody.temperature }
      : {}),
    ...(numberParam(chatBody.max_tokens ?? chatBody.max_completion_tokens) !==
    undefined
      ? { max_tokens: chatBody.max_tokens ?? chatBody.max_completion_tokens }
      : {}),
  });
  let upstream: Response;
  if (stream) {
    try {
      upstream = await client.chatCompletions(upstreamBody, { signal });
    } catch (err) {
      record({
        statusCode: 500,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (!upstream.ok) {
      const text = await upstream.text();
      record({
        statusCode: upstream.status,
        errorMessage: `Upstream error (${upstream.status}): ${text.slice(0, 512)}`,
      });
      return errorBody(
        "upstream_error",
        `Upstream error (${upstream.status}): ${text.slice(0, 512)}`,
      );
    }
    record({ statusCode: upstream.status });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        ...(upstream.headers.get("cache-control")
          ? { "Cache-Control": upstream.headers.get("cache-control")! }
          : {}),
      },
    });
  }

  if (cacheKey) {
    const cached = await getCachedResponse(env, organizationId, cacheKey);
    if (cached !== null) {
      record({ statusCode: 200, cacheHit: 1 });
      return new Response(cached, {
        headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      });
    }
  }

  try {
    upstream = await client.chatCompletions(upstreamBody, { signal });
  } catch (err) {
    record({
      statusCode: 500,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    record({
      statusCode: upstream.status,
      errorMessage: `Upstream error (${upstream.status}): ${upstreamText.slice(0, 512)}`,
    });
    return errorBody(
      "upstream_error",
      `Upstream error (${upstream.status}): ${upstreamText.slice(0, 512)}`,
    );
  }
  record({
    statusCode: upstream.status,
    usage: openAiUsageOf(upstreamText),
  });
  if (cacheKey) {
    ctx.waitUntil(
      putCachedResponse(env, organizationId, cacheKey, upstreamText, cacheTtl),
    );
  }
  return new Response(upstreamText, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

function usageOf(message: AssistantMessage): TokenUsage {
  const usage = message.usage;
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  };
}

/** Best-effort usage extraction from an OpenAI-compatible non-stream body. */
function openAiUsageOf(bodyText: string): TokenUsage | null {
  try {
    const parsed = JSON.parse(bodyText) as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const usage = parsed.usage;
    if (!usage) return null;
    return {
      input: usage.prompt_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
      cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
    };
  } catch {
    return null;
  }
}

/** Deterministic JSON for cache keys (sorted keys → key-order-insensitive). */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return undefined;
      seen.add(val);
      if (!Array.isArray(val)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(val).sort())
          sorted[k] = (val as Record<string, unknown>)[k];
        return sorted;
      }
    }
    return val;
  };
  return JSON.stringify(value, replacer);
}
