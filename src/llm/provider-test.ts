import { ProviderSettings } from "./credential-store";
import {
  isVertexProvider,
  parseVertexConfig,
  resolveVertexHeaders,
  vertexBaseUrl,
  vertexChatCompletionsPath,
  vertexModelsPath,
  vertexModelId,
  type VertexSettings,
} from "./google-vertex";
import { resolveDefaultModel } from "./model-catalog";
import {
  canonicalProviderName,
  getPiAiProviderSpec,
  getV1ProviderSpec,
  isCustomProviderName,
  providerApiId,
} from "./provider-registry";
import { V1OpenAICompatibleClient } from "./v1-provider";

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  error?: string;
  modelCount?: number;
  /** Diagnostic details for the probe (endpoint, masked key, latency, …). */
  details?: ProviderTestDetails;
}

export interface ProviderTestDetails {
  provider: string;
  method?: string;
  endpoint?: string;
  /** Masked credential hint, e.g. `AIza…aB12` or `service-account JSON (2048 bytes)`. */
  keyHint?: string;
  /** Masked auth header actually sent, e.g. `authorization=Bearer sk-…abcd`. */
  authHeader?: string;
  requestSnippet?: string;
  responseStatus?: number;
  responseSnippet?: string;
  latencyMs?: number;
  modelCount?: number;
  error?: string;
}

interface TestTarget {
  url: string;
  headers: Record<string, string>;
}

const SNIPPET_MAX = 300;
const PROBE_TIMEOUT_MS = 10_000;
/** Minimal user turn sent by the chat probe; harmless on every provider. */
const PROBE_USER_TEXT = "echo pong for this ping request";

/** Mask a credential for logging/display without leaking it. */
export function maskSecret(secret: string): string {
  const s = secret.trim();
  if (s.startsWith("{")) return `service-account JSON (${s.length} bytes)`;
  if (s.length <= 8) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function truncate(text: string): string {
  const t = text.trim();
  return t.length > SNIPPET_MAX ? `${t.slice(0, SNIPPET_MAX)}…` : t;
}

/** Summarize the auth header actually sent, with the secret value masked. */
function authHeaderSummary(headers: Record<string, string>): string {
  const entry = Object.entries(headers).find(([k]) =>
    ["authorization", "x-api-key", "x-goog-api-key"].includes(k),
  );
  if (!entry) return "none";
  const [name, value] = entry;
  const bearer = value.startsWith("Bearer ") ? "Bearer " : "";
  const secret = bearer ? value.slice("Bearer ".length) : value;
  return `${name}=${bearer}${maskSecret(secret)}`;
}

function pickKey(
  provider: string,
  keys: string[],
  _needsKey: boolean,
): string | undefined {
  return keys.find((k) => typeof k === "string" && k.trim().length > 0)?.trim();
}

/** The model id a probe (or request) should use for this provider. */
function resolveProbeModel(
  settings: ProviderSettings | undefined,
  provider: string,
): string | undefined {
  return resolveDefaultModel(settings, provider);
}

/** OpenAI-compatible chat body used for openai-completions and V1 providers. */
function openAiChatBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: PROBE_USER_TEXT }],
    max_tokens: 1,
  });
}

/** Anthropic messages body. */
function anthropicChatBody(model: string): string {
  return JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: "user", content: PROBE_USER_TEXT }],
  });
}

/** Google generateContent body (model lives in the URL). */
function generateContentBody(): string {
  return JSON.stringify({
    contents: [{ role: "user", parts: [{ text: PROBE_USER_TEXT }] }],
  });
}

/**
 * Resolve where + how to probe a provider's connectivity. Prefers pi-ai specs
 * for built-ins; falls back to V1 specs or custom OpenAI-compatible settings.
 * Used as a connectivity fallback when no default model id is available.
 */
export function resolveTestTarget(input: {
  provider: string;
  keys: string[];
  settings?: ProviderSettings;
}):
  | { target: TestTarget; needsKey: boolean; keyHint: string }
  | { error: string } {
  const provider = canonicalProviderName(input.provider);
  const piSpec = getPiAiProviderSpec(provider);

  if (piSpec) {
    const api = providerApiId(provider);
    const needsKey = true;
    const key = pickKey(provider, input.keys, needsKey);
    if (!key) return { error: "No API key provided to test" };
    const headers: Record<string, string> = {};
    if (api === "anthropic-messages") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (api === "google-generative-ai") {
      headers["x-goog-api-key"] = key;
    } else {
      headers.authorization = `Bearer ${key}`;
    }
    return {
      target: { url: `${piSpec.baseUrl}/models`, headers },
      needsKey,
      keyHint: maskSecret(key),
    };
  }

  const v1Spec = getV1ProviderSpec(provider);
  const settings = input.settings ?? {};
  // Custom OpenAI-compatible endpoints may be local (Ollama/LM Studio) and
  // keyless; the upstream returns 401 when a key is actually required.
  const needsKey = isCustomProviderName(provider)
    ? false
    : (v1Spec?.needsKey ?? true);
  const baseUrl =
    (settings.baseUrl as string | undefined) ?? v1Spec?.baseUrl ?? "";
  // For custom OpenAI-compatible providers, default to OpenAI's standard path
  const modelsPath =
    (settings.modelsPath as string | undefined) ??
    v1Spec?.modelsPath ??
    (isCustomProviderName(provider) ? "/v1/models" : "/models");
  if (!baseUrl) {
    return { error: "No base URL for this provider" };
  }
  const key = pickKey(provider, input.keys, needsKey);
  if (needsKey && !key) return { error: "No API key provided to test" };
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  // Normalize URL construction to avoid double slashes
  const base = baseUrl.replace(/\/+$/, "");
  const path = modelsPath.startsWith("/") ? modelsPath : `/${modelsPath}`;
  return {
    target: { url: `${base}${path}`, headers },
    needsKey,
    keyHint: key ? maskSecret(key) : "none (local provider)",
  };
}

interface ChatProbeRequest {
  target: TestTarget;
  needsKey: boolean;
  keyHint: string;
  modelId: string;
  body: string;
}

/**
 * Build a tiny chat-completions probe request for a provider using the resolved
 * default model id, so the test validates connectivity, auth and the model id
 * end-to-end (a wrong model id surfaces as an upstream error).
 */
export function resolveChatProbe(input: {
  provider: string;
  keys: string[];
  settings?: ProviderSettings;
  modelId: string;
}): { request: ChatProbeRequest } | { error: string } {
  const provider = canonicalProviderName(input.provider);
  const modelId = input.modelId;

  const piSpec = getPiAiProviderSpec(provider);
  if (piSpec) {
    const api = providerApiId(provider);
    const key = pickKey(provider, input.keys, true);
    if (!key) return { error: "No API key provided to test" };
    const headers: Record<string, string> = {};
    let url: string;
    let body: string;
    if (api === "anthropic-messages") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      url = `${piSpec.baseUrl}/messages`;
      body = anthropicChatBody(modelId);
    } else if (api === "google-generative-ai") {
      headers["x-goog-api-key"] = key;
      url = `${piSpec.baseUrl}/models/${modelId}:generateContent`;
      body = generateContentBody();
    } else {
      headers.authorization = `Bearer ${key}`;
      url = `${piSpec.baseUrl}/chat/completions`;
      body = openAiChatBody(modelId);
    }
    return {
      request: {
        target: {
          url,
          headers: { "content-type": "application/json", ...headers },
        },
        needsKey: true,
        keyHint: maskSecret(key),
        modelId,
        body,
      },
    };
  }

  const v1Spec = getV1ProviderSpec(provider);
  const settings = input.settings ?? {};
  const needsKey = isCustomProviderName(provider)
    ? false
    : (v1Spec?.needsKey ?? true);
  const baseUrl =
    (settings.baseUrl as string | undefined) ?? v1Spec?.baseUrl ?? "";
  // For custom OpenAI-compatible providers, default to OpenAI's standard path
  const chatCompletionPath =
    (settings.chatCompletionPath as string | undefined) ??
    v1Spec?.chatCompletionPath ??
    (isCustomProviderName(provider) ? "/v1/chat/completions" : "/chat/completions");
  if (!baseUrl) return { error: "No base URL for this provider" };
  const key = pickKey(provider, input.keys, needsKey);
  if (needsKey && !key) return { error: "No API key provided to test" };
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  // Normalize URL construction to avoid double slashes
  const base = baseUrl.replace(/\/+$/, "");
  const path = chatCompletionPath.startsWith("/")
    ? chatCompletionPath
    : `/${chatCompletionPath}`;
  return {
    request: {
      target: {
        url: `${base}${path}`,
        headers: { "content-type": "application/json", ...headers },
      },
      needsKey,
      keyHint: key ? maskSecret(key) : "none (local provider)",
      modelId,
      body: openAiChatBody(modelId),
    },
  };
}

function parseModelCount(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: unknown[]; models?: unknown[] };
    const items = parsed.data ?? parsed.models;
    return Array.isArray(items) ? items.length : undefined;
  } catch {
    return undefined;
  }
}

function logProbe(details: ProviderTestDetails, ok: boolean) {
  const parts = [
    `[provider-test] ${ok ? "OK" : "FAIL"} ${details.provider}`,
    `${details.method ?? "-"} ${details.endpoint ?? "-"}`,
    `key=${details.keyHint ?? "-"}`,
    `auth=${details.authHeader ?? "none"}`,
    `latency=${details.latencyMs ?? 0}ms`,
    `status=${details.responseStatus ?? "-"}`,
  ];
  if (details.modelCount !== undefined)
    parts.push(`models=${details.modelCount}`);
  if (details.error) parts.push(`error=${details.error}`);
  if (details.requestSnippet) parts.push(`request=${details.requestSnippet}`);
  if (details.responseSnippet)
    parts.push(`response=${details.responseSnippet}`);
  console.log(parts.join(" | "));
}

/**
 * Probe a provider connection end-to-end: with a default model id available a
 * tiny chat-completions request is sent (validating the model id too); without
 * one, a lightweight models-list request checks connectivity only. Unsaved keys
 * are fine — nothing is persisted here. Logs a diagnostic line and attaches the
 * same details to the result for debugging.
 */
export async function testProviderConnection(input: {
  provider: string;
  keys: string[];
  settings?: ProviderSettings;
}): Promise<ProviderTestResult> {
  const provider = canonicalProviderName(input.provider);

  if (isVertexProvider(provider)) {
    let vertex: { settings: VertexSettings; credential: string };
    try {
      vertex = parseVertexConfig({
        settings: input.settings,
        keys: input.keys,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error,
        details: { provider, error },
      };
    }
    const headers = await resolveVertexHeaders(vertex);
    const keyHint = maskSecret(vertex.credential);
    const modelId = resolveProbeModel(input.settings, provider);
    if (!modelId) {
      return probe(
        provider,
        {
          url: `${vertexBaseUrl(vertex.settings.location)}${vertexModelsPath(
            vertex.settings.projectId,
            vertex.settings.location,
          )}`,
          headers,
        },
        { method: "GET", keyHint },
      );
    }
    if (vertex.settings.authMode === "api-key") {
      // Express Mode: no project/location, native generateContent call.
      return probe(
        provider,
        {
          url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${modelId}:generateContent`,
          headers: { "content-type": "application/json", ...headers },
        },
        { method: "POST", keyHint, body: generateContentBody() },
      );
    }
    return probe(
      provider,
      {
        url: `${vertexBaseUrl(vertex.settings.location)}${vertexChatCompletionsPath(
          vertex.settings.projectId,
          vertex.settings.location,
        )}`,
        headers: { "content-type": "application/json", ...headers },
      },
      {
        method: "POST",
        keyHint,
        body: openAiChatBody(vertexModelId(modelId)),
      },
    );
  }

  const modelId = resolveProbeModel(input.settings, provider);
  if (!modelId) {
    const resolved = resolveTestTarget(input);
    if ("error" in resolved) {
      return {
        ok: false,
        error: resolved.error,
        details: { provider, error: resolved.error },
      };
    }
    return probe(provider, resolved.target, {
      method: "GET",
      keyHint: resolved.keyHint,
    });
  }

  const chat = resolveChatProbe({ ...input, provider, modelId });
  if ("error" in chat) {
    return {
      ok: false,
      error: chat.error,
      details: { provider, error: chat.error },
    };
  }
  return probe(provider, chat.request.target, {
    method: "POST",
    keyHint: chat.request.keyHint,
    body: chat.request.body,
  });
}

interface ProbeOptions {
  method: "GET" | "POST";
  keyHint: string;
  body?: string;
}

async function probe(
  provider: string,
  target: TestTarget,
  opts: ProbeOptions,
): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const init: RequestInit = {
    method: opts.method,
    headers: target.headers,
    ...(opts.body ? { body: opts.body } : {}),
    signal: controller.signal,
  };
  try {
    const res = await fetch(target.url, init);
    const body = await res.text().catch(() => "");
    const latencyMs = Date.now() - startedAt;
    const details: ProviderTestDetails = {
      provider,
      method: opts.method,
      endpoint: target.url,
      keyHint: opts.keyHint,
      authHeader: authHeaderSummary(target.headers),
      requestSnippet: opts.body ? truncate(opts.body) : undefined,
      responseStatus: res.status,
      responseSnippet: truncate(body),
      latencyMs,
    };
    if (res.ok) {
      const modelCount = parseModelCount(body);
      details.modelCount = modelCount;
      logProbe(details, true);
      return { ok: true, status: res.status, modelCount, details };
    }
    const message =
      extractErrorMessage(body) || `Upstream error (${res.status})`;
    details.error = message;
    logProbe(details, false);
    return { ok: false, status: res.status, error: message, details };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Request timed out"
        : err instanceof Error
          ? err.message
          : String(err);
    const details: ProviderTestDetails = {
      provider,
      method: opts.method,
      endpoint: target.url,
      keyHint: opts.keyHint,
      authHeader: authHeaderSummary(target.headers),
      requestSnippet: opts.body ? truncate(opts.body) : undefined,
      latencyMs,
      error: message,
    };
    logProbe(details, false);
    return { ok: false, error: message, details };
  } finally {
    clearTimeout(timeout);
  }
}

function extractErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "object" && parsed.error?.message) {
      return parsed.error.message;
    }
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through to raw truncation below
  }
  const trimmed = body.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

export interface ProviderModelsResult {
  ok: boolean;
  models?: { id: string; api: string }[];
  status?: number;
  error?: string;
}

/**
 * Fetch the model ids a provider actually exposes, so custom endpoints can be
 * configured from the live list instead of typing ids by hand. Works for pi-ai
 * built-ins (models-list endpoint) and V1/custom OpenAI-compatible endpoints
 * (their `modelsPath`). Vertex Express Mode has no model list, so it errors.
 */
export async function fetchProviderModels(input: {
  provider: string;
  keys: string[];
  settings?: ProviderSettings;
}): Promise<ProviderModelsResult> {
  const provider = canonicalProviderName(input.provider);
  if (isVertexProvider(provider)) {
    return {
      ok: false,
      error: "Vertex AI has no model-list endpoint (Express Mode)",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const piSpec = getPiAiProviderSpec(provider);
    if (piSpec) {
      const resolved = resolveTestTarget(input);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const res = await fetch(resolved.target.url, {
        headers: resolved.target.headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: extractErrorMessage(await res.text()) || `HTTP ${res.status}`,
        };
      }
      const json = (await res.json()) as {
        data?: { id?: string }[];
        models?: { name?: string }[];
      };
      const ids = (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string")
        .concat(
          (json.models ?? [])
            .map((m) => m.name)
            .filter((n): n is string => typeof n === "string"),
        );
      return {
        ok: true,
        models: ids.map((id) => ({ id, api: "openai-completions" })),
      };
    }

    const client = new V1OpenAICompatibleClient({
      provider,
      keys: input.keys,
      custom: input.settings?.baseUrl
        ? {
            baseUrl: input.settings.baseUrl as string,
            chatCompletionPath: input.settings.chatCompletionPath as
              string | undefined,
            modelsPath: input.settings.modelsPath as string | undefined,
          }
        : undefined,
    });
    const res = await client.models({ signal: controller.signal });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: extractErrorMessage(await res.text()) || `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as { data?: { id?: string }[] };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return {
      ok: true,
      models: ids.map((id) => ({ id, api: "openai-completions" })),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === "AbortError"
          ? "Request timed out"
          : err instanceof Error
            ? err.message
            : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
