import { describe, it, expect, vi } from "vitest";
import {
  maskSecret,
  resolveTestTarget,
  testProviderConnection,
} from "~/src/llm/provider-test";

vi.mock("~/src/llm/google-oauth", () => ({
  getGoogleAccessToken: vi.fn(async () => "fake-oauth-token"),
  parseServiceAccount: vi.fn(),
  clearGoogleTokenCache: vi.fn(),
}));

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

  it("includes a masked key hint in the resolved target", () => {
    const out = resolveTestTarget({
      provider: "openai",
      keys: ["sk-oai-abcdef"],
      settings: {},
    });
    expect(out).toMatchObject({
      keyHint: "sk-oai…cdef",
    });
  });

  it("marks local providers (no key) with a clear hint", () => {
    const out = resolveTestTarget({
      provider: "ollama",
      keys: [],
      settings: {},
    });
    expect(out).toMatchObject({
      keyHint: "none (local provider)",
      target: { headers: {} },
      needsKey: false,
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
  it("posts a tiny chat call with the built-in default model on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderConnection({
      provider: "openai",
      keys: ["sk"],
      settings: {},
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer sk",
          "content-type": "application/json",
        },
        body: expect.stringContaining('"model":"gpt-4o-mini"'),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("uses the configured default model when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await testProviderConnection({
      provider: "openai",
      keys: ["sk"],
      settings: { defaultModel: "gpt-5" },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ model: "gpt-5" });
    vi.unstubAllGlobals();
  });

  it("reports upstream errors from a wrong/denied model id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "model not found" } }),
          {
            status: 404,
          },
        ),
      ),
    );
    const result = await testProviderConnection({
      provider: "anthropic",
      keys: ["sk-ant"],
      settings: { defaultModel: "claude-nonexistent" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toBe("model not found");
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

  it("falls back to a models-list probe when no default model exists and includes authorization header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "a" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderConnection({
      provider: "custom-openai",
      keys: ["sk-custom-secret"],
      settings: { baseUrl: "https://gw.example.com", modelsPath: "/v1/models" },
    });
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gw.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer sk-custom-secret",
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("probes custom OpenAI-compatible provider with default model and authorization header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderConnection({
      provider: "nvidia-deepseek-v4-flash",
      keys: ["nvapi-secret-key"],
      settings: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        defaultModel: "deepseek-ai/deepseek-v4-flash-0731",
      },
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer nvapi-secret-key",
          "content-type": "application/json",
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("probes Google Vertex AI Express Mode (api-key) via generateContent with the default model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: {} }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderConnection({
      provider: "google-vertex",
      keys: ["AIza-vertex"],
      settings: { authMode: "api-key" },
    });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-goog-api-key": "AIza-vertex",
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("uses a custom default model id in the Express probe URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await testProviderConnection({
      provider: "google-vertex",
      keys: ["AIza-vertex"],
      settings: { authMode: "api-key", defaultModel: "gemini-5.0" },
    });
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/models/gemini-5.0:generateContent",
    );
    vi.unstubAllGlobals();
  });

  it("probes Google Vertex AI service-account mode through the OpenAI-compatible chat endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await testProviderConnection({
      provider: "google-vertex",
      keys: ["{service-account-json}"],
      settings: {
        authMode: "service-account",
        projectId: "p",
        location: "global",
      },
    });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi/chat/completions",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer fake-oauth-token",
        "x-goog-user-project": "p",
      },
    });
    expect(JSON.parse(init.body)).toMatchObject({
      model: "google/gemini-2.5-flash",
    });
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
    expect(result.details).toMatchObject({
      provider: "google-vertex",
      error: expect.stringMatching(/authMode/),
    });
  });
});

describe("maskSecret", () => {
  it("shows only the first 6 + last 4 characters of a key", () => {
    expect(maskSecret("AIza1234567890abcdef")).toBe("AIza12…cdef");
    expect(maskSecret("sk-abc")).toBe("sk…");
  });

  it("summarizes service-account JSON blobs by size", () => {
    expect(maskSecret('{"type":"service_account","client_email":"x"}')).toMatch(
      /^service-account JSON \(\d+ bytes\)$/,
    );
  });
});

describe("testProviderConnection diagnostics", () => {
  it("returns endpoint, masked key, latency and response snippet on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "pong" } }] }),
            { status: 200 },
          ),
        ),
    );
    const result = await testProviderConnection({
      provider: "openai",
      keys: ["sk-oai-abcdef"],
      settings: {},
    });
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({
      provider: "openai",
      method: "POST",
      endpoint: "https://api.openai.com/v1/chat/completions",
      keyHint: "sk-oai…cdef",
      authHeader: "authorization=Bearer sk-oai…cdef",
      responseStatus: 200,
      latencyMs: expect.any(Number),
    });
    expect(result.details?.requestSnippet).toContain('"model":"gpt-4o-mini"');
    expect(result.details?.responseSnippet).toContain('"content":"pong"');
    vi.unstubAllGlobals();
  });

  it("attaches masked auth, status and error details on upstream failures", async () => {
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
      keys: ["sk-ant-xyz"],
      settings: {},
    });
    expect(result.ok).toBe(false);
    expect(result.details).toMatchObject({
      provider: "anthropic",
      keyHint: "sk-ant…-xyz",
      authHeader: "x-api-key=sk-ant…-xyz",
      responseStatus: 401,
      error: "bad key",
    });
    expect(result.details?.responseSnippet).toContain("bad key");
    vi.unstubAllGlobals();
  });

  it("reports request/response details on network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );
    const result = await testProviderConnection({
      provider: "openai",
      keys: ["sk-oai-abcdef"],
      settings: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fetch failed");
    expect(result.details).toMatchObject({
      provider: "openai",
      method: "POST",
      keyHint: "sk-oai…cdef",
      error: "fetch failed",
    });
    expect(result.details?.endpoint).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    vi.unstubAllGlobals();
  });

  it("includes the request body snippet for the Vertex Express probe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ candidates: [{ content: {} }] }), {
          status: 200,
        }),
      ),
    );
    const result = await testProviderConnection({
      provider: "google-vertex",
      keys: ["AIza-vertex"],
      settings: { authMode: "api-key" },
    });
    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({
      provider: "google-vertex",
      method: "POST",
      endpoint:
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent",
      keyHint: "AIza-v…rtex",
      authHeader: "x-goog-api-key=AIza-v…rtex",
    });
    expect(result.details?.requestSnippet).toContain(
      '"text":"echo pong for this ping request"',
    );
    vi.unstubAllGlobals();
  });
});
