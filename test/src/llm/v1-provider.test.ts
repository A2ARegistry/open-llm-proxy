import { afterEach, describe, expect, it, vi } from "vitest";
import { V1OpenAICompatibleClient } from "~/src/llm/v1-provider";

describe("V1OpenAICompatibleClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Cloudflare account ID and embeddings endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "cloudflare-workers-ai",
      keys: ["cf-token"],
      custom: { accountId: "a".repeat(32) },
    });

    await client.embeddings(
      JSON.stringify({ model: "@cf/baai/bge-large-en-v1.5", input: "hello" }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1/embeddings`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer cf-token" }),
      }),
    );
  });

  it("fails over to the next key on retryable upstream errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "custom-openai",
      keys: ["first-key", "second-key"],
      rotationStrategy: "failover",
      custom: { baseUrl: "https://example.com/v1" },
    });

    const response = await client.chatCompletions("{}");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(
      "Bearer first-key",
    );
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe(
      "Bearer second-key",
    );
  });

  it("sends requests through an injected fetcher instead of global fetch", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const binding = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        ),
    };
    const client = new V1OpenAICompatibleClient({
      provider: "local-box",
      keys: [],
      custom: { baseUrl: "http://127.0.0.1:11435" },
      fetcher: binding,
    });

    await client.chatCompletions("{}");
    await client.models();

    expect(globalFetch).not.toHaveBeenCalled();
    expect(binding.fetch).toHaveBeenCalledTimes(2);
    expect(binding.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:11435/v1/chat/completions",
    );
    expect(binding.fetch.mock.calls[1][0]).toBe(
      "http://127.0.0.1:11435/v1/models",
    );
  });

  it("does not retry when first-key mode is selected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "custom-openai",
      keys: ["first-key", "second-key"],
      rotationStrategy: "first",
      custom: { baseUrl: "https://example.com/v1" },
    });

    const response = await client.chatCompletions("{}");

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// [fork] W2: keyless custom providers (the local box has no API key).
describe("V1OpenAICompatibleClient without keys", () => {
  it("sends no authorization header for a keyless custom provider", async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    };
    const client = new V1OpenAICompatibleClient({
      provider: "local-m5",
      keys: [],
      custom: { baseUrl: "http://127.0.0.1:11435" },
      fetcher: binding,
    });

    await client.chatCompletions("{}");

    const headers = binding.fetch.mock.calls[0][1].headers;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain(
      "authorization",
    );
  });
});
