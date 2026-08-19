import { describe, it, expect, vi } from "vitest";
import {
  resolveTestTarget,
  testProviderConnection,
} from "~/src/llm/provider-test";

describe("resolveTestTarget", () => {
  it("uses x-api-key + anthropic-version for Anthropic", () => {
    const out = resolveTestTarget({
      provider: "anthropic",
      keys: ["sk-ant"],
      settings: {},
    });
    expect(out).toMatchObject({
      target: {
        url: expect.stringMatching(/\/models$/),
        headers: { "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" },
      },
      needsKey: true,
    });
  });

  it("uses x-goog-api-key for Google AI Studio", () => {
    const out = resolveTestTarget({
      provider: "google-ai-studio",
      keys: ["gg-key"],
      settings: {},
    });
    expect(out).toMatchObject({
      target: {
        url: expect.stringMatching(/\/models$/),
        headers: { "x-goog-api-key": "gg-key" },
      },
    });
  });

  it("uses a Bearer header for OpenAI-compatible providers", () => {
    const out = resolveTestTarget({
      provider: "openai",
      keys: ["sk-oai"],
      settings: {},
    });
    expect(out).toMatchObject({
      target: {
        url: expect.stringMatching(/\/models$/),
        headers: { authorization: "Bearer sk-oai" },
      },
    });
  });

  it("honors custom baseUrl/modelsPath for custom endpoints", () => {
    const out = resolveTestTarget({
      provider: "custom-openai",
      keys: ["sk-custom"],
      settings: { baseUrl: "https://gw.example.com", modelsPath: "/v1/models" },
    });
    expect(out).toMatchObject({
      target: { url: "https://gw.example.com/v1/models" },
    });
  });

  it("fails when a key is required but missing", () => {
    const out = resolveTestTarget({
      provider: "openai",
      keys: [],
      settings: {},
    });
    expect("error" in out).toBe(true);
  });

  it("does not require a key for Ollama", () => {
    const out = resolveTestTarget({
      provider: "ollama",
      keys: [],
      settings: {},
    });
    expect("error" in out).toBe(false);
  });

  it("fails when a custom provider has no baseUrl", () => {
    const out = resolveTestTarget({
      provider: "custom-openai",
      keys: ["sk"],
      settings: {},
    });
    expect("error" in out).toBe(true);
  });
});

describe("testProviderConnection", () => {
  it("returns ok with model count on a successful probe", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderConnection({
      provider: "openai",
      keys: ["sk"],
      settings: {},
    });
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/models$/),
      expect.objectContaining({ headers: { authorization: "Bearer sk" } }),
    );
    vi.unstubAllGlobals();
  });

  it("reports upstream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
        }),
      ),
    );
    const result = await testProviderConnection({
      provider: "anthropic",
      keys: ["sk-ant"],
      settings: {},
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("bad key");
    vi.unstubAllGlobals();
  });

  it("surfaces network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );
    const result = await testProviderConnection({
      provider: "openai",
      keys: ["sk"],
      settings: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fetch failed");
    vi.unstubAllGlobals();
  });

  it("probes Google Vertex AI through the OpenAI-compatible endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gemini-2.5-flash" }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderConnection({
      provider: "google-vertex",
      keys: ["AIza-vertex"],
      settings: { authMode: "api-key", projectId: "p", location: "global" },
    });
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/models",
      expect.objectContaining({ headers: { "x-goog-api-key": "AIza-vertex" } }),
    );
    vi.unstubAllGlobals();
  });

  it("fails cleanly for an unconfigured Google Vertex AI provider", async () => {
    const result = await testProviderConnection({
      provider: "google-vertex",
      keys: [],
      settings: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/authMode/);
  });
});
