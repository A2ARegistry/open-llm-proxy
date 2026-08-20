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
}

interface TestTarget {
  url: string;
  headers: Record<string, string>;
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
}): { target: TestTarget; needsKey: boolean } | { error: string } {
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
  return { target: { url: `${baseUrl}${modelsPath}`, headers }, needsKey };
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

/**
 * Probe a provider connection with a lightweight models-list request using the
 * candidate API keys (unsaved keys are fine — nothing is persisted here).
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
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const headers = await resolveVertexHeaders(vertex);
    // Express Mode (api-key): no project/location, no OpenAI-compat models
    // endpoint — verify connectivity through a minimal generateContent call.
    if (vertex.settings.authMode === "api-key") {
      return probeVertexExpress(headers);
    }
    return probe({
      url: `${vertexBaseUrl(vertex.settings.location)}${vertexModelsPath(
        vertex.settings.projectId,
        vertex.settings.location,
      )}`,
      headers,
    });
  }

  const resolved = resolveTestTarget(input);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  return probe(resolved.target);
}

/** Express Mode probe endpoint (global host, no project/location). */
const VERTEX_EXPRESS_GENERATE_URL =
  "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent";

async function probe(target: TestTarget): Promise<ProviderTestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(target.url, {
      method: "GET",
      headers: target.headers,
      signal: controller.signal,
    });
    if (res.ok) {
      const modelCount = parseModelCount(await res.text());
      return { ok: true, status: res.status, modelCount };
    }
    const body = await res.text().catch(() => "");
    const message =
      extractErrorMessage(body) || `Upstream error (${res.status})`;
    return { ok: false, status: res.status, error: message };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? "Request timed out"
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: aborted };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Express Mode has no models-list endpoint, so connectivity is verified with a
 * minimal generateContent call against a stable base model. Only auth is tested;
 * the response body is discarded.
 */
async function probeVertexExpress(
  headers: Record<string, string>,
): Promise<ProviderTestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(VERTEX_EXPRESS_GENERATE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
      }),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => "");
    const message =
      extractErrorMessage(body) || `Upstream error (${res.status})`;
    return { ok: false, status: res.status, error: message };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name === "AbortError"
        ? "Request timed out"
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: aborted };
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
