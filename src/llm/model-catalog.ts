import {
  canonicalProviderName,
  getPiAiProviderSpec,
} from "./provider-registry";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelMetadata {
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  reasoning?: boolean;
}

const GEMINI_CONTEXT_WINDOW = 1048576;
const GEMINI_MAX_TOKENS = 65536;

/**
 * Resolve the id under which pi-ai's baked catalog keys this provider's models
 * (registry names and spec ids may differ — e.g. "google-ai-studio" is cataloged
 * as "google", "xai" as "xai" while its spec id is "grok").
 */
export function builtinCatalogId(provider: string): string | undefined {
  const known = getBuiltinProviders() as string[];
  const candidates = [provider, getPiAiProviderSpec(provider)?.id];
  return candidates.find(
    (c): c is string => typeof c === "string" && known.includes(c),
  );
}

/** Models from pi-ai's baked catalog for a provider (empty when not covered). */
export function builtinModels(provider: string): Record<string, unknown>[] {
  const id = builtinCatalogId(provider);
  if (!id) return [];
  try {
    return getBuiltinModels(
      id as Parameters<typeof getBuiltinModels>[0],
    ) as unknown as Record<string, unknown>[];
  } catch {
    return [];
  }
}

/** The provider id pi-ai actually registers (spec.id), falling back to the name. */
export function registeredProviderId(provider: string): string {
  return getPiAiProviderSpec(provider)?.id ?? provider;
}

export function isGeminiFamily(modelId: string): boolean {
  return /gemini|gemma|palm/.test(modelId.toLowerCase());
}

/**
 * Best-effort metadata for a model id that isn't in the baked catalog (e.g. a
 * newly released model). Requests pass through to upstream regardless — this
 * only feeds /v1/models listing and cost/thinking accounting.
 */
export function synthesizedMetadata(modelId: string): ModelMetadata {
  if (!isGeminiFamily(modelId)) return {};
  const lower = modelId.toLowerCase();
  const pro = /-pro\b/.test(lower);
  const lite = /-lite/.test(lower);
  const cost: ModelCost = pro
    ? { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }
    : lite
      ? { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 }
      : { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 };
  return {
    contextWindow: GEMINI_CONTEXT_WINDOW,
    maxTokens: GEMINI_MAX_TOKENS,
    cost,
    reasoning: true,
  };
}

/** Union `extra` ids into the baked list; baked entries win on duplicates. */
export function mergeModels<T extends { id: string }>(
  baked: T[],
  extra: T[],
): T[] {
  const merged = [...baked];
  for (const item of extra) {
    if (!merged.some((m) => m.id === item.id)) merged.push(item);
  }
  return merged;
}

/** Normalize an upstream model id to the bare id used in /v1/models + requests. */
export function normalizeProviderModelId(id: string, provider: string): string {
  let out = id;
  if (canonicalProviderName(provider) === "google-ai-studio")
    out = out.replace(/^models\//, "");
  if (canonicalProviderName(provider) === "google-vertex")
    out = out.replace(/^google\//, "");
  return out;
}
