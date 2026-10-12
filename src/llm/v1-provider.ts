import {
  getV1ProviderSpec,
  getPiAiProviderSpec,
  canonicalProviderName,
} from "./provider-registry";

export type KeyRotationStrategy = "first" | "round-robin" | "failover";

/** Native-fetch client for OpenAI-compatible providers. */
export class V1OpenAICompatibleClient {
  private readonly baseUrl: string;
  private readonly chatCompletionPath: string;
  private readonly modelsPath: string;
  private readonly embeddingsPath: string;
  private readonly keys: string[];
  private readonly needsKey: boolean;
  private readonly extraHeaders: Record<string, string>;
  private readonly authHeaders?: Record<string, string>;
  private readonly rotationStrategy: KeyRotationStrategy;
  private static rotationCursor = 0;

  constructor(options: {
    provider: string;
    baseUrl?: string;
    chatCompletionPath?: string;
    modelsPath?: string;
    embeddingsPath?: string;
    keys: string[];
    rotationStrategy?: KeyRotationStrategy;
    custom?: {
      baseUrl?: string;
      accountId?: string;
      chatCompletionPath?: string;
      modelsPath?: string;
      embeddingsPath?: string;
    };
    authHeaders?: Record<string, string>;
  }) {
    const canonical = canonicalProviderName(options.provider);
    const spec = getV1ProviderSpec(canonical);
    const piSpec = getPiAiProviderSpec(canonical);
    const isCustom = !spec && !piSpec;
    this.keys = options.keys.filter((key) => typeof key === "string" && key.trim()).map((key) => key.trim());
    this.needsKey = spec?.needsKey ?? true;
    let configuredBaseUrl = options.custom?.baseUrl ?? options.baseUrl ?? spec?.baseUrl ?? piSpec?.baseUrl ?? "";
    if (canonical === "cloudflare-workers-ai") {
      const accountId = options.custom?.accountId;
      if (accountId) configuredBaseUrl = configuredBaseUrl.replace("{account_id}", accountId);
    }
    this.baseUrl = configuredBaseUrl;
    this.chatCompletionPath = options.custom?.chatCompletionPath ?? options.chatCompletionPath ?? spec?.chatCompletionPath ?? (isCustom ? "/v1/chat/completions" : "/chat/completions");
    this.modelsPath = options.custom?.modelsPath ?? options.modelsPath ?? spec?.modelsPath ?? (isCustom ? "/v1/models" : "/models");
    this.embeddingsPath = options.custom?.embeddingsPath ?? options.embeddingsPath ?? spec?.embeddingsPath ?? (isCustom ? "/v1/embeddings" : "/embeddings");
    this.extraHeaders = {};
    this.authHeaders = options.authHeaders;
    this.rotationStrategy = options.rotationStrategy ?? "first";
  }

  private keyOrder(): string[] {
    if (this.keys.length < 2 || this.rotationStrategy === "first") return this.keys;
    if (this.rotationStrategy === "failover") return this.keys;
    const start = V1OpenAICompatibleClient.rotationCursor++ % this.keys.length;
    return [...this.keys.slice(start), ...this.keys.slice(0, start)];
  }

  private headers(key?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
      ...(this.authHeaders ?? {}),
    };
    if (!this.authHeaders && key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  private fullUrl(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${base}${normalized}`;
  }

  private shouldTryNext(response: Response): boolean {
    return [401, 403, 429, 500, 502, 503, 504].includes(response.status);
  }

  private async request(path: string, init: { method: string; body?: string; signal?: AbortSignal }): Promise<Response> {
    const keys = this.keyOrder();
    const attempts = this.rotationStrategy === "first" ? keys.slice(0, 1) : keys;
    let lastResponse: Response | undefined;
    for (let index = 0; index < Math.max(attempts.length, 1); index++) {
      const response = await fetch(this.fullUrl(path), {
        ...init,
        headers: this.headers(attempts[index]),
      });
      lastResponse = response;
      if (response.ok || !this.shouldTryNext(response) || index === attempts.length - 1) return response;
      // Consume the failed response before trying another credential.
      await response.arrayBuffer();
    }
    return lastResponse!;
  }

  chatCompletionsUrl(): string { return this.fullUrl(this.chatCompletionPath); }
  embeddingsUrl(): string { return this.fullUrl(this.embeddingsPath); }

  async chatCompletions(body: string, init?: { signal?: AbortSignal }): Promise<Response> {
    return this.request(this.chatCompletionPath, { method: "POST", body, signal: init?.signal });
  }

  async embeddings(body: string, init?: { signal?: AbortSignal }): Promise<Response> {
    return this.request(this.embeddingsPath, { method: "POST", body, signal: init?.signal });
  }

  async models(init?: { signal?: AbortSignal }): Promise<Response> {
    return this.request(this.modelsPath, { method: "GET", signal: init?.signal });
  }
}
