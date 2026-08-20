import { ProviderSettings } from "./credential-store";
import {
  isVertexProvider,
  parseVertexConfig,
  resolveVertexHeaders,
  vertexBaseUrl,
  vertexModelsPath,
  type VertexSettings,
} from "./google-vertex";
import {
  canonicalProviderName,
  getPiAiProviderSpec,
  getV1ProviderSpec,
  providerApiId,
} from "./provider-registry";

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
  needsKey: boolean,
): string | undefined {
  if (!needsKey) return undefined;
  return keys[0];
}

/**
 * Resolve where + how to probe a provider's connectivity. Prefers pi-ai specs
 * for built-ins; falls back to V1 specs or custom OpenAI-compatible settings.
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
  const needsKey = v1Spec?.needsKey ?? true;
  const baseUrl =
    (settings.baseUrl as string | undefined) ?? v1Spec?.baseUrl ?? "";
  const modelsPath =
    (settings.modelsPath as string | undefined) ??
    v1Spec?.modelsPath ??
    "/models";
  if (!baseUrl) {
    return { error: "No base URL for this provider" };
  }
  const key = pickKey(provider, input.keys, needsKey);
  if (needsKey && !key) return { error: "No API key provided to test" };
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  return {
    target: { url: `${baseUrl}${modelsPath}`, headers },
    needsKey,
    keyHint: key ? maskSecret(key) : "none (local provider)",
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
 * Probe a provider connection with a lightweight request using the candidate
 * API keys (unsaved keys are fine — nothing is persisted here). Logs a
 * diagnostic line (endpoint, masked key, latency, request/response snippets)
 * and attaches the same details to the result for debugging.
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
    // Express Mode (api-key): no project/location, no OpenAI-compat models
    // endpoint — verify connectivity through a minimal generateContent call.
    if (vertex.settings.authMode === "api-key") {
      return probe(
        provider,
        {
          url: VERTEX_EXPRESS_GENERATE_URL,
          headers: { "content-type": "application/json", ...headers },
        },
        {
          method: "POST",
          keyHint,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "ping" }] }],
          }),
        },
      );
    }
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

/** Express Mode probe endpoint (global host, no project/location). */
const VERTEX_EXPRESS_GENERATE_URL =
  "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent";

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
