import { getV1ProviderSpec, canonicalProviderName } from "./provider-registry";

/**
 * Native-fetch OpenAI-compatible client for providers pi-ai does not cover
 * first-class (ollama, cohere, perplexity-ai, custom OpenAI-compatible
 * endpoints). Reuses the V1 request semantics without the static env globals.
 */
export class V1OpenAICompatibleClient {
  private readonly baseUrl: string;
  private readonly chatCompletionPath: string;
  private readonly modelsPath: string;
  private readonly keys: string[];
  private readonly needsKey: boolean;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: {
    provider: string;
    baseUrl?: string;
    chatCompletionPath?: string;
    modelsPath?: string;
    keys: string[];
    custom?: {
      baseUrl?: string;
      chatCompletionPath?: string;
      modelsPath?: string;
    };
  }) {
    const canonical = canonicalProviderName(options.provider);
    const spec = getV1ProviderSpec(canonical);
    this.keys = options.keys;
    this.needsKey = spec?.needsKey ?? true;
    this.baseUrl =
      options.custom?.baseUrl ?? options.baseUrl ?? spec?.baseUrl ?? "";
    this.chatCompletionPath =
      options.custom?.chatCompletionPath ??
      options.chatCompletionPath ??
      spec?.chatCompletionPath ??
      "/chat/completions";
    this.modelsPath =
      options.custom?.modelsPath ??
      options.modelsPath ??
      spec?.modelsPath ??
      "/models";
    this.extraHeaders = {};
    if (canonical === "perplexity-ai") {
      // Perplexity honors OpenAI-compatible headers already; no extras.
    }
    if (canonical === "cohere") {
      // Cohere accepts OpenAI-compatible headers already; no extras.
    }
  }

  private getKey(): string | undefined {
    if (!this.needsKey) return undefined;
    return this.keys[0];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
    };
    const key = this.getKey();
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  private fullUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async chatCompletions(
    body: string,
    init?: { signal?: AbortSignal },
  ): Promise<Response> {
    return fetch(this.fullUrl(this.chatCompletionPath), {
      method: "POST",
      headers: this.headers(),
      body,
      signal: init?.signal,
    });
  }

  async models(init?: { signal?: AbortSignal }): Promise<Response> {
    return fetch(this.fullUrl(this.modelsPath), {
      method: "GET",
      headers: this.headers(),
      signal: init?.signal,
    });
  }
}
