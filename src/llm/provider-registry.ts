import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export type LlmMode = "pi-ai" | "v1" | "vertex";

export interface RegisteredProvider {
  id: string;
  name: string;
  mode: LlmMode;
  /** pi-ai provider instance factory (mode === 'pi-ai'). */
  provider?: ReturnType<typeof createProvider>;
  /** V1 fallback connection details (mode === 'v1'). */
  baseUrl?: string;
  chatCompletionPath?: string;
  modelsPath?: string;
}

interface PiAiProviderSpec {
  id: string;
  name: string;
  baseUrl: string;
  api:
    | ReturnType<typeof openAICompletionsApi>
    | ReturnType<typeof anthropicMessagesApi>
    | ReturnType<typeof googleGenerativeAIApi>
    | ReturnType<typeof googleVertexApi>;
}

const OPENAI_COMPAT_API = openAICompletionsApi();
const ANTHROPIC_API = anthropicMessagesApi();
const GOOGLE_API = googleGenerativeAIApi();
const VERTEX_API = googleVertexApi();

/**
 * pi-ai-covered providers, mapped to their OpenAI-compatible (or native) API.
 * Credentials come from the per-tenant credential store at resolution time.
 */
const PI_AI_PROVIDERS: Record<string, PiAiProviderSpec> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: OPENAI_COMPAT_API,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: ANTHROPIC_API,
  },
  "google-ai-studio": {
    id: "google",
    name: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: GOOGLE_API,
  },
  google: {
    id: "google",
    name: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    api: GOOGLE_API,
  },
  // Google Vertex AI (Express Mode): an API key is the only credential needed.
  // Requests use the native @google/genai generateContent API against the global
  // `aiplatform.googleapis.com` host; the `{location}` placeholder tells the
  // pi-ai vertex adapter to keep the SDK's own Express-mode base URL.
  "google-vertex": {
    id: "google-vertex",
    name: "Google Vertex AI",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    api: VERTEX_API,
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    api: OPENAI_COMPAT_API,
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    api: OPENAI_COMPAT_API,
  },
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    api: OPENAI_COMPAT_API,
  },
  grok: {
    id: "grok",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    api: OPENAI_COMPAT_API,
  },
  xai: {
    id: "grok",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    api: OPENAI_COMPAT_API,
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    api: OPENAI_COMPAT_API,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: OPENAI_COMPAT_API,
  },
  huggingface: {
    id: "huggingface",
    name: "HuggingFace",
    baseUrl: "https://router.huggingface.co",
    api: OPENAI_COMPAT_API,
  },
};

/** Providers routed through the V1 native-fetch layer (pi-ai has no first-class support). */
const V1_FALLBACK_PROVIDERS: Record<
  string,
  {
    name: string;
    baseUrl: string;
    chatCompletionPath: string;
    modelsPath: string;
    needsKey: boolean;
  }
> = {
  ollama: {
    name: "Ollama",
    baseUrl: "https://ollama.com/v1",
    chatCompletionPath: "/chat/completions",
    modelsPath: "/models",
    needsKey: false,
  },
  cohere: {
    name: "Cohere",
    baseUrl: "https://api.cohere.com",
    chatCompletionPath: "/compatibility/v1/chat/completions",
    modelsPath: "/compatibility/v1/models?page_size=100&endpoint=chat",
    needsKey: true,
  },
  "perplexity-ai": {
    name: "Perplexity AI",
    baseUrl: "https://api.perplexity.ai",
    chatCompletionPath: "/chat/completions",
    modelsPath: "/models",
    needsKey: true,
  },
};

/** Names a provider may use internally in requests, mapped to a canonical id. */
export function canonicalProviderName(name: string): string {
  if (name === "google") return "google-ai-studio";
  if (name === "xai") return "grok";
  if (name === "vertex" || name === "google-vertex") return "google-vertex";
  return name;
}

export function resolveProviderMode(name: string): LlmMode {
  if (name === "google-vertex") return "vertex";
  if (PI_AI_PROVIDERS[name]) return "pi-ai";
  if (V1_FALLBACK_PROVIDERS[name]) return "v1";
  // Unknown provider names default to pi-ai when they look like built-in ids;
  // otherwise treat as a custom OpenAI-compatible endpoint (v1).
  return "v1";
}

export function buildPiAiProvider(spec: PiAiProviderSpec) {
  return createProvider({
    id: spec.id,
    name: spec.name,
    baseUrl: spec.baseUrl,
    auth: {
      apiKey: {
        name: `${spec.name} API key`,
        resolve: async ({ credential }) => {
          if (credential?.type === "api_key" && credential.key) {
            return { auth: { apiKey: credential.key } };
          }
          return undefined;
        },
      },
    },
    models: [],
    api: spec.api,
  });
}

export function getPiAiProviderSpec(
  name: string,
): PiAiProviderSpec | undefined {
  return PI_AI_PROVIDERS[name];
}

/** Whether a name refers to a known provider (canonical id in the registry). */
export function isKnownProviderName(name: string): boolean {
  const canonical = canonicalProviderName(name);
  return canonical in PI_AI_PROVIDERS || canonical in V1_FALLBACK_PROVIDERS;
}

export function getV1ProviderSpec(name: string) {
  return V1_FALLBACK_PROVIDERS[name];
}

export interface BuiltinProviderCatalogEntry {
  provider: string;
  name: string;
  mode: LlmMode;
  needsKey: boolean;
}

/** All built-in providers, deduped by canonical id (aliases like `google`/`xai` skipped). */
export function listBuiltinProviders(): BuiltinProviderCatalogEntry[] {
  const rows: BuiltinProviderCatalogEntry[] = [];
  for (const key of Object.keys(PI_AI_PROVIDERS)) {
    if (canonicalProviderName(key) !== key) continue;
    rows.push({
      provider: key,
      name: PI_AI_PROVIDERS[key].name,
      mode: resolveProviderMode(key),
      needsKey: true,
    });
  }
  for (const key of Object.keys(V1_FALLBACK_PROVIDERS)) {
    rows.push({
      provider: key,
      name: V1_FALLBACK_PROVIDERS[key].name,
      mode: resolveProviderMode(key),
      needsKey: V1_FALLBACK_PROVIDERS[key].needsKey,
    });
  }
  return rows;
}

export const PI_AI_PROVIDER_NAMES = Object.keys(PI_AI_PROVIDERS);
export const V1_PROVIDER_NAMES = Object.keys(V1_FALLBACK_PROVIDERS);

/** pi-ai API name used for request building, per provider id. */
export function providerApiId(
  name: string,
):
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex" {
  const spec = getPiAiProviderSpec(name);
  if (spec?.api === ANTHROPIC_API) return "anthropic-messages";
  if (spec?.api === GOOGLE_API) return "google-generative-ai";
  if (spec?.api === VERTEX_API) return "google-vertex";
  return "openai-completions";
}
