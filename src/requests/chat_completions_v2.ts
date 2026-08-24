import { TenantService } from "../db/tenant";
import { getProviderConfig } from "../llm/credential-store";
import { GoogleDirectAdapter } from "../llm/google-direct-adapter";
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
  parseModelString,
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
  isCustomProviderName,
  isKnownProviderName,
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
import { TraceSession, textCaptureTransform } from "../tracing/collector";
import { ApiKeyAuth } from "../types";
import { log } from "../utils/logger";
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

  log.info(
    `[chat-completions] Request started | org=${organizationId} | keyId=${apiKeyAuth.keyId} | boundProvider=${apiKeyAuth.scopes.defaultProvider || "none"}`,
  );

  const tenants = new TenantService(env.DB);
  const settings = await tenants.getSettings(organizationId);

  const tenantBlocked = assertTenantActive(settings);
  if (tenantBlocked) {
    log.warn(`[chat-completions] Tenant blocked: ${tenantBlocked.message}`);
    return errorBody(tenantBlocked.code, tenantBlocked.message);
  }

  const sbDisabledUntil = apiKeyAuth.spendDisabledUntil;
  const tenantSpendDisabledUntil = settings.spendDisabledUntil as
    number | undefined;
  if (sbDisabledUntil && Date.now() / 1000 < sbDisabledUntil) {
    log.warn(`[chat-completions] API key spend cap reached`);
    return errorBody("spend_limit_exceeded", "API key spend cap reached");
  }
  if (
    tenantSpendDisabledUntil &&
    Date.now() / 1000 < tenantSpendDisabledUntil
  ) {
    log.warn(`[chat-completions] Tenant spend limit reached`);
    return errorBody("spend_limit_exceeded", "Tenant spend limit reached");
  }

  const body = parseBody(await request.text());
  if (!body) {
    log.warn(`[chat-completions] Invalid request body`);
    return errorBody("invalid_model", "Invalid request body");
  }
  const chatBody = body as unknown as ChatCompletionsRequest;

  // Never log message contents: prompts may contain user-sensitive data.
  // Log only structural metadata (message count) for correlation.
  const messageCount = Array.isArray(chatBody.messages)
    ? chatBody.messages.length
    : 0;

  const rawModel = typeof body.model === "string" ? body.model.trim() : "";

  // An API key may be bound to a provider (scopes.defaultProvider): the key
  // then only ever routes to that provider and users can send bare model ids.
  // Unbound keys must name the provider explicitly (`provider/model`).
  const boundProvider = apiKeyAuth.scopes.defaultProvider
    ? canonicalProviderName(apiKeyAuth.scopes.defaultProvider)
    : undefined;

  let providerName: string;
  let modelId: string;

  if (boundProvider) {
    const parsed = parseModelString(rawModel);
    if (
      parsed.provider &&
      canonicalProviderName(parsed.provider) !== boundProvider
    ) {
      return errorBody(
        "provider_mismatch",
        `API key is bound to provider '${boundProvider}'; cannot use '${parsed.provider}'`,
      );
    }
    providerName = boundProvider;
    modelId = parsed.model;
  } else {
    if (!rawModel) {
      return errorBody(
        "not_configured",
        "Model must be formatted as 'provider/model' (or set a default provider on the API key)",
      );
    }
    const parsed = parseModelString(rawModel);
    if (parsed.provider) {
      providerName = canonicalProviderName(parsed.provider);
      modelId = parsed.model;
    } else if (isKnownProviderName(parsed.model)) {
      providerName = canonicalProviderName(parsed.model);
      modelId = "";
    } else {
      return errorBody(
        "not_configured",
        "Model must be formatted as 'provider/model' (e.g. 'openai/gpt-4o') or set a default provider on the API key",
      );
    }
  }

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
  if (!isCustomProviderName(providerName) && config.keys.length === 0) {
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

  // Diagnostic tracing (provider `settings.trace`) — opt-in, testing only.
  // Captures raw + converted request/response payloads for bug investigation.
  const trace =
    config.settings?.trace === true
      ? new TraceSession({
          organizationId,
          apiKeyId: apiKeyAuth.keyId,
          provider: providerName,
          model: modelId,
          stream,
        }).setInboundRequest(chatBody)
      : null;
  /** Submit the trace event in the background when tracing is enabled. */
  const submitTrace = (): void => {
    if (!trace) return;
    ctx.waitUntil(trace.finish());
  };

  // Google Vertex AI routing:
  // - Express Mode (api-key): Use GoogleDirectAdapter for proper tool call handling
  // - Service Account mode: Use OpenAI-compatible endpoint (existing V1 path)
  const vertexExpressMode =
    isVertexProvider(providerName) && config.settings?.authMode === "api-key";
  const vertexOpenAiCompat =
    isVertexProvider(providerName) &&
    config.settings?.authMode === "service-account";
  const piSpec = getPiAiProviderSpec(providerName);

  log.debug(
    `[chat-completions] Resolved provider | provider=${providerName} | model=${modelId} | stream=${stream} | messages=${messageCount} | piSpec=${!!piSpec} | vertexOpenAiCompat=${vertexOpenAiCompat} | vertexExpressMode=${vertexExpressMode} | authMode=${config.settings?.authMode} | isVertex=${isVertexProvider(providerName)}`,
  );

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
    stream,
  });
  if (!rate.allowed) {
    log.warn(
      `[chat-completions] Rate limited | org=${organizationId} key=${apiKeyAuth.keyId} retryAfter=${rate.retryAfter ?? 1}`,
    );
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

  // Route 1: Google Vertex Express Mode (api-key) - Use direct Google SDK adapter
  if (vertexExpressMode) {
    const apiKey = config.keys[0];
    if (!apiKey) {
      return errorBody(
        "not_configured",
        "Google Vertex Express Mode requires an API key",
      );
    }

    const googleAdapter = new GoogleDirectAdapter({ apiKey });

    // Extract tools from request
    const tools = Array.isArray(chatBody.tools)
      ? chatBody.tools.map((t: unknown) => {
          const tool = t as {
            type: string;
            function: {
              name: string;
              description?: string;
              parameters?: unknown;
            };
          };
          return {
            type: tool.type || "function",
            function: {
              name: tool.function?.name || "",
              description: tool.function?.description,
              parameters: tool.function?.parameters as Record<string, unknown>,
            },
          };
        })
      : undefined;

    if (!stream) {
      if (cacheKey) {
        const cached = await getCachedResponse(env, organizationId, cacheKey);
        if (cached !== null) {
          record({ statusCode: 200, cacheHit: 1 });
          trace?.setOutboundResponse("(served from response cache)");
          submitTrace();
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
        message = await googleAdapter.generateContent({
          model: modelId,
          messages: chatBody.messages as never[],
          tools,
          temperature: numberParam(chatBody.temperature),
          maxTokens: maxTokens,
          trace: trace
            ? {
                onUpstreamRequest: (body) =>
                  trace.setUpstreamRequest({ method: "POST", body }),
                onUpstreamResponse: (body) =>
                  trace.setUpstreamResponse({ body }),
              }
            : undefined,
        });
      } catch (err) {
        record({
          statusCode: 500,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        trace?.setUpstreamResponse({
          error: err instanceof Error ? err.message : String(err),
        });
        submitTrace();
        throw err;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        record({
          statusCode: 403,
          usage: usageOf(message),
          costUsd: message.usage?.cost?.total ?? null,
          errorMessage: message.errorMessage ?? "Upstream provider error",
        });
        trace?.setOutboundResponse(message.errorMessage ?? "Upstream error");
        submitTrace();
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
      trace?.setOutboundResponse(bodyText);
      submitTrace();
      if (cacheKey) {
        ctx.waitUntil(
          putCachedResponse(env, organizationId, cacheKey, bodyText, cacheTtl),
        );
      }
      return new Response(bodyText, {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Streaming mode
    const chunks: string[] = [];
    const state = { emittedRole: false };
    const responseId = `chatcmpl-${Math.random().toString(36).slice(2)}`;
    let finalMessage: AssistantMessage | undefined;
    try {
      for await (const event of googleAdapter.streamGenerateContent({
        model: modelId,
        messages: chatBody.messages as never[],
        tools,
        temperature: numberParam(chatBody.temperature),
        maxTokens,
        trace: trace
          ? {
              onUpstreamRequest: (body) =>
                trace.setUpstreamRequest({ method: "POST", body }),
              onUpstreamStreamChunk: (chunk) => trace.addUpstreamChunk(chunk),
            }
          : undefined,
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
      log.debug(
        `[chat-completions] Streaming completed | provider=${providerName} | model=${modelId} | responseId=${responseId} | chunks=${chunks.length} | ` +
          `finalStopReason=${finalMessage?.stopReason}`,
      );
    } catch (err) {
      record({
        statusCode: 500,
        usage: finalMessage ? usageOf(finalMessage) : null,
        costUsd: finalMessage?.usage?.cost?.total ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      trace?.setUpstreamResponse({
        error: err instanceof Error ? err.message : String(err),
      });
      submitTrace();
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
    const sseText = encodeSse(chunks);
    trace?.setOutboundResponse(sseText);
    submitTrace();
    return new Response(sseText, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // Route 2: Other providers using pi-ai (keep existing logic)
  if (piSpec && !vertexOpenAiCompat) {
    const models = await createTenantModels({
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
          trace?.setOutboundResponse("(served from response cache)");
          submitTrace();
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
        trace?.setUpstreamResponse({
          error: err instanceof Error ? err.message : String(err),
        });
        submitTrace();
        throw err;
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        record({
          statusCode: 403,
          usage: usageOf(message),
          costUsd: message.usage?.cost?.total ?? null,
          errorMessage: message.errorMessage ?? "Upstream provider error",
        });
        trace?.setOutboundResponse(message.errorMessage ?? "Upstream error");
        submitTrace();
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
      // pi-ai does not expose the raw upstream exchange; only inbound +
      // converted outbound are available on this route.
      trace?.setOutboundResponse(bodyText);
      submitTrace();
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
      log.debug(
        `[chat-completions] Streaming completed | provider=${providerName} | model=${modelId} | responseId=${responseId} | chunks=${chunks.length} | ` +
          `finalStopReason=${finalMessage?.stopReason}` +
          (finalMessage?.stopReason === "error"
            ? ` | error=${finalMessage?.errorMessage ?? "unknown"}`
            : ""),
      );
    } catch (err) {
      record({
        statusCode: 500,
        usage: finalMessage ? usageOf(finalMessage) : null,
        costUsd: finalMessage?.usage?.cost?.total ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      trace?.setUpstreamResponse({
        error: err instanceof Error ? err.message : String(err),
      });
      submitTrace();
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
    const sseText = encodeSse(chunks);
    // pi-ai does not expose the raw upstream exchange; only inbound +
    // converted outbound are available on this route.
    trace?.setOutboundResponse(sseText);
    submitTrace();
    return new Response(sseText, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // Route 3: V1 fallback (Ollama, Cohere, Perplexity, custom OpenAI-compatible endpoints)
  // and Google Vertex AI Service Account mode (OpenAI-compatible endpoint with custom auth).
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
      const baseUrl = vertexBaseUrl(vertex.settings.location);
      const chatPath = vertexChatCompletionsPath(
        vertex.settings.projectId,
        vertex.settings.location,
      );
      log.debug(
        `[chat-completions] Vertex service-account upstream | baseUrl=${baseUrl}`,
      );
      client = new V1OpenAICompatibleClient({
        provider: providerName,
        baseUrl,
        chatCompletionPath: chatPath,
        modelsPath: vertexModelsPath(
          vertex.settings.projectId,
          vertex.settings.location,
        ),
        keys: config.keys,
        authHeaders: vertexAuth,
      });
    } catch (err) {
      log.error(`[chat-completions] Vertex setup failed`, err);
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
  trace?.setUpstreamRequest({
    endpoint: client.chatCompletionsUrl(),
    method: "POST",
    body: upstreamBody,
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
      trace?.setUpstreamResponse({
        error: err instanceof Error ? err.message : String(err),
      });
      submitTrace();
      throw err;
    }
    if (!upstream.ok) {
      const text = await upstream.text();
      record({
        statusCode: upstream.status,
        errorMessage: `Upstream error (${upstream.status}): ${text.slice(0, 512)}`,
      });
      trace?.setUpstreamResponse({ status: upstream.status, body: text });
      submitTrace();
      return errorBody(
        "upstream_error",
        `Upstream error (${upstream.status}): ${text.slice(0, 512)}`,
      );
    }
    // Usage arrives in the final SSE chunk: pass the stream through a
    // capturing transform and record once it completes (or is cancelled).
    if (!upstream.body) {
      record({ statusCode: upstream.status });
      submitTrace();
      return new Response(null, { status: upstream.status });
    }
    const capturedText = trace ? textCaptureTransform() : null;
    const sseStream = upstream.body.pipeThrough(
      usageCapturingTransform((usage) => {
        record({ statusCode: upstream.status, usage });
      }),
    );
    const tracedStream = capturedText
      ? sseStream.pipeThrough(capturedText.stream)
      : sseStream;
    if (trace && capturedText) {
      ctx.waitUntil(
        capturedText.done.then((sse) => {
          // Raw pass-through stream: what we capture is both the raw upstream
          // response and the outbound body.
          trace.setUpstreamResponse({
            status: upstream.status,
            body: sse,
          });
          return trace.setOutboundResponse(sse).finish();
        }),
      );
    }
    return new Response(tracedStream, {
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
      trace?.setOutboundResponse("(served from response cache)");
      submitTrace();
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
    trace?.setUpstreamResponse({
      error: err instanceof Error ? err.message : String(err),
    });
    submitTrace();
    throw err;
  }
  const upstreamText = await upstream.text();
  if (!upstream.ok) {
    record({
      statusCode: upstream.status,
      errorMessage: `Upstream error (${upstream.status}): ${upstreamText.slice(0, 512)}`,
    });
    trace?.setUpstreamResponse({ status: upstream.status, body: upstreamText });
    submitTrace();
    return errorBody(
      "upstream_error",
      `Upstream error (${upstream.status}): ${upstreamText.slice(0, 512)}`,
    );
  }
  record({
    statusCode: upstream.status,
    usage: openAiUsageOf(upstreamText),
  });
  trace?.setUpstreamResponse({ status: upstream.status, body: upstreamText });
  trace?.setOutboundResponse(upstreamText);
  submitTrace();
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

/** Map an OpenAI-compatible usage object to the proxy TokenUsage shape. */
function openAiUsageOfObject(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}): TokenUsage {
  const cacheRead =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    0;
  return {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead),
    output: usage.completion_tokens ?? 0,
    cacheRead,
    cacheWrite: 0,
  };
}

/** Best-effort usage extraction from an OpenAI-compatible non-stream body. */
function openAiUsageOf(bodyText: string): TokenUsage | null {
  try {
    const parsed = JSON.parse(bodyText) as {
      usage?: Parameters<typeof openAiUsageOfObject>[0];
    };
    if (!parsed.usage) return null;
    return openAiUsageOfObject(parsed.usage);
  } catch {
    return null;
  }
}

/**
 * Best-effort usage extraction from a buffered OpenAI-compatible SSE stream:
 * scans `data:` lines and returns the usage of the last chunk that carries one
 * (providers emit it in the final chunk; `[DONE]` and garbage are ignored).
 */
export function sseUsageOf(sseText: string): TokenUsage | null {
  let usage: TokenUsage | null = null;
  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as {
        usage?: Parameters<typeof openAiUsageOfObject>[0];
      };
      if (parsed.usage) usage = openAiUsageOfObject(parsed.usage);
    } catch {
      // Ignore keep-alives / partial lines.
    }
  }
  return usage;
}

const USAGE_TAIL_BYTES = 64 * 1024;

/**
 * Pass-through SSE transform that captures the upstream body so usage can be
 * parsed when the stream ends (or is cancelled), then recorded exactly once.
 */
export function usageCapturingTransform(
  record: (usage: TokenUsage | null) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let tail = "";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    record(sseUsageOf(tail));
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      tail += decoder.decode(chunk, { stream: true });
      // Bound memory: usage only ever appears in the final chunks.
      if (tail.length > USAGE_TAIL_BYTES * 2)
        tail = tail.slice(-USAGE_TAIL_BYTES);
    },
    flush() {
      finish();
    },
    cancel() {
      finish();
    },
  });
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
