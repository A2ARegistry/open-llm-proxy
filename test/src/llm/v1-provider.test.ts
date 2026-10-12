import { afterEach, describe, expect, it, vi } from "vitest";
import { V1OpenAICompatibleClient } from "~/src/llm/v1-provider";

describe("V1OpenAICompatibleClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Cloudflare account ID and embeddings endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new V1OpenAICompatibleClient({
      provider: "cloudflare-workers-ai",
      keys: ["cf-token"],
      custom: { accountId: "a".repeat(32) },
    });

    await client.embeddings(JSON.stringify({ model: "@cf/baai/bge-large-en-v1.5", input: "hello" }));

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
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
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer first-key");
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer second-key");
  });

  it("does not retry when first-key mode is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("denied", { status: 401 }));
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
