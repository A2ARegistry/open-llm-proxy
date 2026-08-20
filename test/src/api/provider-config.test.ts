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
import { testProviderConnection } from "~/src/llm/provider-test";
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
}));

const mockGetProviderConfig = vi.mocked(getProviderConfig);
const mockListProviderConfigs = vi.mocked(listProviderConfigs);
const mockSaveProviderConfig = vi.mocked(saveProviderConfig);
const mockDeleteProviderConfig = vi.mocked(deleteProviderConfig);
const mockTestProviderConnection = vi.mocked(testProviderConnection);

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
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-");
    expect(serialized).not.toContain("keys");
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
