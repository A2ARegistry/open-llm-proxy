import { log } from "../utils/logger";
import { createTenantCredentialStore } from "./credential-store";
import {
  builtinModels,
  registeredProviderId,
  synthesizedMetadata,
} from "./model-catalog";
import {
  buildPiAiProvider,
  getPiAiProviderSpec,
  type RegisteredProvider,
} from "./provider-registry";
// Try importing Models class directly instead of createModels factory
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  MutableModels,
} from "@earendil-works/pi-ai";

export type PiModelApi =
  | "openai-completions"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex";

export interface StreamResult {
  registered: RegisteredProvider[];
  complete(input: {
    model: Model<PiModelApi>;
    context: Context;
    signal?: AbortSignal;
  }): Promise<AssistantMessage>;
  stream(input: {
    model: Model<PiModelApi>;
    context: Context;
    signal?: AbortSignal;
  }): AsyncIterable<AssistantMessageEvent>;
}

export interface TenantModelsOptions {
  env: Env;
  organizationId: string;
  enabledProviders: string[];
}

export async function createTenantModels(
  options: TenantModelsOptions,
): Promise<StreamResult> {
  const { env, organizationId, enabledProviders } = options;
  const store = createTenantCredentialStore(env, organizationId);

  // Try dynamic import to avoid bundler issues
  let models: MutableModels;
  try {
    // Import createModels dynamically
    const piAi = await import("@earendil-works/pi-ai");
    models = piAi.createModels({
      credentials: store,
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    });
  } catch (err) {
    log.error(`[models-factory] Dynamic import failed`, err);
    throw err;
  }

  const registered: RegisteredProvider[] = [];
  for (const name of enabledProviders) {
    const spec = getPiAiProviderSpec(name);
    if (!spec) {
      log.warn(`[models-factory] No pi-ai spec for provider: ${name}`);
      continue;
    }
    const provider = buildPiAiProvider(spec);
    models.setProvider(provider);
    registered.push({ id: spec.id, name: spec.name, mode: "pi-ai" });
    log.debug(`[models-factory] Registered provider: ${name} (id=${spec.id})`);
  }

  return {
    registered,
    complete({ model, context, signal }) {
      return models.complete(model, context, { signal });
    },
    async *stream({ model, context, signal }) {
      const source = models.stream(model, context, { signal });
      for await (const event of source) {
        yield event;
      }
    },
  };
}

const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 8192;

export function modelFor(
  provider: string,
  modelId: string,
  api: PiModelApi,
): Model<PiModelApi> {
  // The id pi-ai actually registers (spec.id) — NOT the registry name, which can
  // differ (e.g. "google-ai-studio" registers as "google").
  const providerId = registeredProviderId(provider);
  const baked = builtinModels(provider).find(
    (m) => (m as { id?: string }).id === modelId,
  ) as Model<PiModelApi> | undefined;
  if (baked) {
    return { ...baked, api, provider: providerId } as Model<PiModelApi>;
  }
  const meta = synthesizedMetadata(modelId);
  return {
    id: modelId,
    name: modelId,
    api,
    provider: providerId,
    baseUrl: getPiAiProviderSpec(provider)?.baseUrl ?? "",
    reasoning: meta.reasoning ?? false,
    input: ["text", "image"],
    cost: meta.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: meta.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: meta.maxTokens ?? FALLBACK_MAX_TOKENS,
  } as Model<PiModelApi>;
}
