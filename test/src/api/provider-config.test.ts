import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { providerConfigRouter } from "~/src/api/provider-config";
import type { AppBindings } from "~/src/app";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import {
  getProviderConfig,
  listProviderConfigs,
  saveProviderConfig,
  deleteProviderConfig,
} from "~/src/llm/credential-store";
import {
  fetchProviderModels,
  testProviderConnection,
} from "~/src/llm/provider-test";
import type { SessionAuth } from "~/src/types";

vi.mock("~/src/llm/credential-store", () => ({
  getProviderConfig: vi.fn(),
  listProviderConfigs: vi.fn(),
  saveProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
}));

vi.mock("~/src/audit/audit-logger", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/src/llm/provider-test", () => ({
  testProviderConnection: vi.fn(),
  fetchProviderModels: vi.fn(),
}));

const mockGetProviderConfig = vi.mocked(getProviderConfig);
const mockListProviderConfigs = vi.mocked(listProviderConfigs);
const mockSaveProviderConfig = vi.mocked(saveProviderConfig);
const mockDeleteProviderConfig = vi.mocked(deleteProviderConfig);
const mockTestProviderConnection = vi.mocked(testProviderConnection);
const mockFetchProviderModels = vi.mocked(fetchProviderModels);

const session: SessionAuth = {
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: "org_1",
  role: "owner",
  email: "owner@acme.test",
  expiresAt: 9999999999,
};

function buildApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", (c, next) => {
    c.set("session", session);
    return next();
  });
  app.route("/api/providers", providerConfigRouter);
  return app;
}

function config(
  over: Partial<DecryptedProviderConfig> = {},
): DecryptedProviderConfig {
  return {
    id: "pcfg_1",
    provider: "openai",
    enabled: true,
    keys: ["sk-openai-test"],
    settings: { timeout: 60 },
    updatedAt: 123,
    ...over,
  };
}

async function fetchJson(
  app: Hono<AppBindings>,
  path: string,
  init?: RequestInit,
) {
  const res = await app.request(path, init, {} as never);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/providers", () => {
  it("lists configured providers without exposing keys", async () => {
    mockListProviderConfigs.mockResolvedValue([
      config({ provider: "openai", keys: ["secret-1", "secret-2"] }),
      config({ provider: "cohere", keys: ["secret-3"] }),
    ]);
    const { status, body } = await fetchJson(buildApp(), "/api/providers");
    expect(status).toBe(200);
    expect(body.providers).toHaveLength(2);
    expect(body.providers[0]).toMatchObject({
      provider: "openai",
      name: "OpenAI",
      mode: "pi-ai",
      configured: true,
      enabled: true,
      keyCount: 2,
      defaultModel: "gpt-4o-mini",
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-");
    expect(serialized).not.toContain("keys");
  });

  it("reports the configured defaultModel when settings override the curated one", async () => {
    mockListProviderConfigs.mockResolvedValue([
      config({
        provider: "google-vertex",
        keys: ["k"],
        settings: { authMode: "api-key", defaultModel: "gemini-5.0" },
      }),
    ]);
    const { body } = await fetchJson(buildApp(), "/api/providers");
    expect(body.providers[0].defaultModel).toBe("gemini-5.0");
  });

  it("reports null defaultModel for custom providers without one", async () => {
    mockListProviderConfigs.mockResolvedValue([
      config({
        provider: "custom-openai",
        keys: ["k"],
        settings: { baseUrl: "https://gw.example.com" },
      }),
    ]);
    const { body } = await fetchJson(buildApp(), "/api/providers");
    expect(body.providers[0].defaultModel).toBeNull();
  });

  it("uses settings.name as the display name for custom providers", async () => {
    mockListProviderConfigs.mockResolvedValue([
      config({
        provider: "my-gw",
        keys: ["k"],
        settings: {
          baseUrl: "https://gw.example.com",
          name: "My gateway",
          defaultModel: "local-model",
        },
      }),
    ]);
    const { body } = await fetchJson(buildApp(), "/api/providers");
    expect(body.providers[0].name).toBe("My gateway");
    expect(body.providers[0].defaultModel).toBe("local-model");
  });
});

describe("GET /api/providers/catalog", () => {
  it("lists built-in providers with default models, deduped by canonical id", async () => {
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/catalog",
    );
    expect(status).toBe(200);
    const openai = body.providers.find(
      (p: { provider: string }) => p.provider === "openai",
    );
    const studio = body.providers.find(
      (p: { provider: string }) => p.provider === "google-ai-studio",
    );
    const grok = body.providers.find(
      (p: { provider: string }) => p.provider === "grok",
    );
    const ollama = body.providers.find(
      (p: { provider: string }) => p.provider === "ollama",
    );
    expect(openai.defaultModel).toBe("gpt-4o-mini");
    expect(studio.defaultModel).toBe("gemini-2.5-flash");
    expect(grok).toBeDefined();
    expect(ollama.needsKey).toBe(false);
    // alias ids are skipped
    expect(
      body.providers.find((p: { provider: string }) => p.provider === "google"),
    ).toBeUndefined();
    expect(
      body.providers.find((p: { provider: string }) => p.provider === "xai"),
    ).toBeUndefined();
  });

  it("includes a generic custom OpenAI-compatible entry with no default model", async () => {
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/catalog",
    );
    expect(status).toBe(200);
    const custom = body.providers.find(
      (p: { provider: string }) => p.provider === "custom",
    );
    expect(custom).toMatchObject({
      provider: "custom",
      mode: "v1",
      needsKey: true,
      defaultModel: null,
    });
  });
});

describe("GET /api/providers/:provider", () => {
  it("returns provider detail", async () => {
    mockGetProviderConfig.mockResolvedValue(config({ keys: ["k"] }));
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/openai",
    );
    expect(status).toBe(200);
    expect(body.provider).toBe("openai");
    expect(body.keyCount).toBe(1);
  });

  it("returns an unconfigured shape with 404", async () => {
    mockGetProviderConfig.mockResolvedValue(undefined);
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/anthropic",
    );
    expect(status).toBe(404);
    expect(body.error).toBe("not_configured");
    expect(body.provider.configured).toBe(false);
  });
});

describe("PUT /api/providers/:provider", () => {
  const putJson = (path: string, payload: string) =>
    fetchJson(buildApp(), path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: payload,
    });

  it("saves a provider config and returns the public view", async () => {
    mockSaveProviderConfig.mockResolvedValue(
      config({ provider: "openai", keys: ["k"], enabled: true }),
    );
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/openai",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keys: ["sk-a", "sk-b"],
        }),
      },
    );
    expect(status).toBe(200);
    expect(mockSaveProviderConfig).toHaveBeenCalledWith(
      expect.anything(),
      "org_1",
      "openai",
      expect.objectContaining({ keys: ["sk-a", "sk-b"] }),
    );
    expect(body.keyCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain("sk-a");
  });

  it("rejects an invalid provider id", async () => {
    const { status } = await putJson(
      "/api/providers/Bad%20Provider!",
      '{"keys":["a"]}',
    );
    expect(status).toBe(400);
  });

  it("rejects non-array keys", async () => {
    const { status } = await putJson(
      "/api/providers/openai",
      '{"keys":"sk-a"}',
    );
    expect(status).toBe(400);
  });

  it("rejects too many keys", async () => {
    const keys = Array.from({ length: 21 }, (_, i) => `k${i}`);
    const { status } = await putJson(
      "/api/providers/openai",
      JSON.stringify({ keys }),
    );
    expect(status).toBe(400);
  });

  it("rejects non-object settings", async () => {
    const { status } = await putJson(
      "/api/providers/openai",
      '{"settings":"nope"}',
    );
    expect(status).toBe(400);
  });

  it("rejects settings paths that are not absolute", async () => {
    const { status } = await putJson(
      "/api/providers/openai",
      JSON.stringify({ settings: { chatCompletionPath: "chat/completions" } }),
    );
    expect(status).toBe(400);
  });

  it("rejects an invalid JSON body", async () => {
    const { status } = await putJson("/api/providers/openai", "not-json");
    expect(status).toBe(400);
  });

  it("surfaces a 500 when encryption is unconfigured", async () => {
    mockSaveProviderConfig.mockRejectedValue(
      new Error("ENCRYPTION_KEY secret is not configured"),
    );
    const { status } = await putJson("/api/providers/openai", '{"keys":["a"]}');
    expect(status).toBe(500);
  });

  it("allows toggling settings without keys", async () => {
    mockSaveProviderConfig.mockResolvedValue(
      config({ enabled: true, settings: { timeout: 30 } }),
    );
    const { status } = await fetchJson(buildApp(), "/api/providers/openai", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, settings: { timeout: 30 } }),
    });
    expect(status).toBe(200);
    const call = mockSaveProviderConfig.mock.calls[0][3];
    expect(call.keys).toBeUndefined();
    expect(call.settings).toEqual({ timeout: 30 });
  });

  it("accepts a valid Google Vertex AI Express Mode config (api-key only)", async () => {
    mockSaveProviderConfig.mockResolvedValue(
      config({
        provider: "google-vertex",
        keys: ["AIza-x"],
        enabled: true,
        settings: { authMode: "api-key" },
      }),
    );
    const { status } = await fetchJson(
      buildApp(),
      "/api/providers/google-vertex",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keys: ["AIza-x"],
          settings: { authMode: "api-key" },
        }),
      },
    );
    expect(status).toBe(200);
  });

  it("rejects a Google Vertex AI service-account config missing project/location", async () => {
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/google-vertex",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          keys: ["{sa-json}"],
          settings: { authMode: "service-account" },
        }),
      },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/project ID/);
  });

  it("validates Vertex settings against the stored key when no new key is supplied", async () => {
    mockGetProviderConfig.mockResolvedValue(
      config({
        provider: "google-vertex",
        keys: ["AIza-stored"],
        settings: { authMode: "api-key" },
      }),
    );
    mockSaveProviderConfig.mockResolvedValue(
      config({
        provider: "google-vertex",
        keys: ["AIza-stored"],
        settings: { authMode: "api-key", defaultModel: "gemini-5.0" },
      }),
    );
    const { status } = await fetchJson(
      buildApp(),
      "/api/providers/google-vertex",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          settings: { authMode: "api-key", defaultModel: "gemini-5.0" },
        }),
      },
    );
    expect(status).toBe(200);
    expect(mockSaveProviderConfig.mock.calls[0][3].keys).toBeUndefined();
  });

  it("still rejects a Vertex api-key save when no key exists anywhere", async () => {
    mockGetProviderConfig.mockResolvedValue(null);
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/google-vertex",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { authMode: "api-key" } }),
      },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/API key/);
  });

  it("rejects a custom provider without a base URL", async () => {
    const { status, body } = await putJson(
      "/api/providers/my-gw",
      JSON.stringify({
        keys: ["sk-a"],
        settings: { name: "My gateway", defaultModel: "m" },
      }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseUrl/);
  });

  it("rejects a custom provider with a non-http(s) base URL", async () => {
    const { status, body } = await putJson(
      "/api/providers/my-gw",
      JSON.stringify({ settings: { baseUrl: "ftp://gw.example.com" } }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/baseUrl/);
  });

  it("accepts a keyless custom provider with a base URL", async () => {
    mockSaveProviderConfig.mockResolvedValue(
      config({
        provider: "my-gw",
        keys: [],
        enabled: true,
        settings: {
          baseUrl: "http://localhost:11434/v1",
          customModels: ["llama3"],
          defaultModel: "llama3",
        },
      }),
    );
    const { status, body } = await putJson(
      "/api/providers/my-gw",
      JSON.stringify({
        settings: {
          baseUrl: "http://localhost:11434/v1",
          customModels: ["llama3"],
          defaultModel: "llama3",
        },
      }),
    );
    expect(status).toBe(200);
    expect(body.provider).toBe("my-gw");
    expect(mockSaveProviderConfig.mock.calls[0][3].keys).toBeUndefined();
    expect(mockSaveProviderConfig.mock.calls[0][3].settings).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      customModels: ["llama3"],
    });
  });

  it("rejects non-string customModels entries", async () => {
    const { status, body } = await putJson(
      "/api/providers/my-gw",
      JSON.stringify({
        settings: { baseUrl: "https://gw.example.com", customModels: [42] },
      }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/customModels/);
  });

  it("rejects an invalid custom provider id", async () => {
    const { status } = await putJson(
      "/api/providers/NotValid",
      JSON.stringify({ settings: { baseUrl: "https://gw.example.com" } }),
    );
    expect(status).toBe(400);
  });
});

describe("POST /api/providers/:provider/test", () => {
  const postJson = (path: string, payload: string) =>
    fetchJson(buildApp(), path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

  beforeEach(() => {
    mockTestProviderConnection.mockResolvedValue({
      ok: true,
      status: 200,
      modelCount: 3,
    });
  });

  it("tests with candidate keys and returns the result", async () => {
    const { status, body } = await postJson(
      "/api/providers/openai/test",
      JSON.stringify({ keys: ["sk-candidate"] }),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, status: 200, modelCount: 3 });
    expect(mockTestProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", keys: ["sk-candidate"] }),
    );
  });

  it("falls back to stored keys and merges stored settings", async () => {
    mockGetProviderConfig.mockResolvedValue(
      config({ keys: ["sk-stored"], settings: { timeout: 30 } }),
    );
    const { status } = await postJson(
      "/api/providers/openai/test",
      JSON.stringify({}),
    );
    expect(status).toBe(200);
    expect(mockTestProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: ["sk-stored"],
        settings: { timeout: 30 },
      }),
    );
  });

  it("returns 404 when nothing is configured and no keys given", async () => {
    mockGetProviderConfig.mockResolvedValue(undefined);
    const { status, body } = await postJson(
      "/api/providers/anthropic/test",
      JSON.stringify({}),
    );
    expect(status).toBe(404);
    expect(body.error).toContain("not configured");
    expect(mockTestProviderConnection).not.toHaveBeenCalled();
  });

  it("passes through a failed test result", async () => {
    mockTestProviderConnection.mockResolvedValue({
      ok: false,
      status: 401,
      error: "invalid api key",
    });
    const { status, body } = await postJson(
      "/api/providers/openai/test",
      JSON.stringify({ keys: ["bad"] }),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid api key");
  });

  it("rejects an invalid provider id", async () => {
    const { status } = await postJson(
      "/api/providers/Bad%20Provider!/test",
      JSON.stringify({ keys: ["a"] }),
    );
    expect(status).toBe(400);
  });

  it("rejects invalid keys", async () => {
    const { status } = await postJson(
      "/api/providers/openai/test",
      JSON.stringify({ keys: "not-an-array" }),
    );
    expect(status).toBe(400);
  });

  it("rejects non-object settings", async () => {
    const { status } = await postJson(
      "/api/providers/openai/test",
      JSON.stringify({ settings: "nope" }),
    );
    expect(status).toBe(400);
  });
});

describe("POST /api/providers/:provider/models", () => {
  const postJson = (path: string, payload: string) =>
    fetchJson(buildApp(), path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });

  beforeEach(() => {
    mockFetchProviderModels.mockResolvedValue({
      ok: true,
      models: [{ id: "gpt-4o", api: "openai-completions" }],
    });
  });

  it("fetches the live model list with candidate settings", async () => {
    const { status, body } = await postJson(
      "/api/providers/my-gw/models",
      JSON.stringify({
        keys: ["sk-cand"],
        settings: { baseUrl: "http://localhost:11434/v1" },
      }),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.models).toEqual([{ id: "gpt-4o", api: "openai-completions" }]);
    expect(mockFetchProviderModels).toHaveBeenCalledWith({
      provider: "my-gw",
      keys: ["sk-cand"],
      settings: { baseUrl: "http://localhost:11434/v1" },
    });
  });

  it("falls back to stored keys and merges stored settings", async () => {
    mockGetProviderConfig.mockResolvedValue(
      config({
        provider: "my-gw",
        keys: ["sk-stored"],
        settings: { baseUrl: "https://gw.example.com", timeout: 30 },
      }),
    );
    const { status } = await postJson("/api/providers/my-gw/models", "{}");
    expect(status).toBe(200);
    expect(mockFetchProviderModels).toHaveBeenCalledWith({
      provider: "my-gw",
      keys: ["sk-stored"],
      settings: { baseUrl: "https://gw.example.com", timeout: 30 },
    });
  });

  it("returns 404 when nothing is configured and no keys given", async () => {
    mockGetProviderConfig.mockResolvedValue(undefined);
    const { status, body } = await postJson(
      "/api/providers/my-gw/models",
      "{}",
    );
    expect(status).toBe(404);
    expect(body.error).toContain("not configured");
    expect(mockFetchProviderModels).not.toHaveBeenCalled();
  });

  it("passes through a failed fetch", async () => {
    mockFetchProviderModels.mockResolvedValue({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
    const { status, body } = await postJson(
      "/api/providers/my-gw/models",
      JSON.stringify({
        keys: ["bad"],
        settings: { baseUrl: "https://gw.example.com" },
      }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: 401,
      error: "unauthorized",
    });
  });

  it("rejects an invalid provider id", async () => {
    const { status } = await postJson("/api/providers/NotValid/models", "{}");
    expect(status).toBe(400);
  });
});

describe("DELETE /api/providers/:provider", () => {
  it("returns 404 when the provider does not exist", async () => {
    mockDeleteProviderConfig.mockResolvedValue(false);
    const { status } = await fetchJson(buildApp(), "/api/providers/openai", {
      method: "DELETE",
    });
    expect(status).toBe(404);
  });

  it("deletes the provider config", async () => {
    mockDeleteProviderConfig.mockResolvedValue(true);
    const { status, body } = await fetchJson(
      buildApp(),
      "/api/providers/openai",
      {
        method: "DELETE",
      },
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockDeleteProviderConfig).toHaveBeenCalledWith(
      expect.anything(),
      "org_1",
      "openai",
    );
  });
});
