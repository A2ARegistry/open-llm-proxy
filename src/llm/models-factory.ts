import { createTenantCredentialStore } from "./credential-store";
import {
  buildPiAiProvider,
  getPiAiProviderSpec,
  type RegisteredProvider,
} from "./provider-registry";
import { createModels } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";

export interface StreamResult {
  registered: RegisteredProvider[];
  complete(input: {
    model: Model<
      "openai-completions" | "anthropic-messages" | "google-generative-ai"
    >;
    context: Context;
    signal?: AbortSignal;
  }): Promise<AssistantMessage>;
  stream(input: {
    model: Model<
      "openai-completions" | "anthropic-messages" | "google-generative-ai"
    >;
    context: Context;
    signal?: AbortSignal;
  }): AsyncIterable<AssistantMessageEvent>;
}

export interface TenantModelsOptions {
  env: Env;
  organizationId: string;
  enabledProviders: string[];
}

export function createTenantModels(options: TenantModelsOptions): StreamResult {
  const { env, organizationId, enabledProviders } = options;
  const store = createTenantCredentialStore(env, organizationId);
  const models = createModels({
    credentials: store,
    authContext: {
      env: async () => undefined,
      fileExists: async () => false,
    },
  });

  const registered: RegisteredProvider[] = [];
  for (const name of enabledProviders) {
    const spec = getPiAiProviderSpec(name);
    if (!spec) continue;
    const provider = buildPiAiProvider(spec);
    models.setProvider(provider);
    registered.push({ id: spec.id, name: spec.name, mode: "pi-ai" });
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
  api: "openai-completions" | "anthropic-messages" | "google-generative-ai",
): Model<"openai-completions" | "anthropic-messages" | "google-generative-ai"> {
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: getPiAiProviderSpec(provider)?.baseUrl ?? "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
  } as Model<
    "openai-completions" | "anthropic-messages" | "google-generative-ai"
  >;
}
