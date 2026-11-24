// [fork] W1/W6: chat completions with VPC providers (transport, privacy).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { getCachedResponse, putCachedResponse } from "~/src/llm/response-cache";
import { chatCompletionsV2 } from "~/src/requests/chat_completions_v2";
import { setTraceCollector } from "~/src/tracing/collector";
import type { TraceEvent } from "~/src/tracing/collector";
import type { ApiKeyAuth } from "~/src/types";

const tenant = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

vi.mock("~/src/db/tenant", () => ({
  TenantService: class {
    async getSettings() {
      return tenant.settings;
    }
  },
}));

vi.mock("~/src/llm/response-cache", () => ({
  getCachedResponse: vi.fn().mockResolvedValue(null),
  putCachedResponse: vi.fn().mockResolvedValue(undefined),
  responseCacheKey: vi.fn().mockResolvedValue("cache-key"),
}));

vi.mock("~/src/llm/credential-store", () => ({
  getProviderConfig: vi.fn(),
}));

vi.mock("~/src/llm/rate-limit", () => ({
  checkRateLimits: vi.fn().mockResolvedValue({ allowed: true }),
  settleTokenUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/src/metrics/request-logger", () => ({
  recordChatRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/src/metrics/spend-guard", () => ({
  maybeDisableAfterSpend: vi.fn().mockResolvedValue(undefined),
}));

const mockGetProviderConfig = vi.mocked(getProviderConfig);

const apiKeyAuth = {
  keyId: "key_1",
  organizationId: "org_1",
  scopes: {},
} as unknown as ApiKeyAuth;

const localBox: DecryptedProviderConfig = {
  id: "pcfg_local",
  provider: "local-m5",
  name: "local-m5",
  enabled: true,
  keys: [],
  settings: {
    baseUrl: "http://127.0.0.1:11435",
    chatCompletionPath: "/v1/chat/completions",
    transport: "vpc",
    vpcBinding: "HALOGEN",
  },
  updatedAt: 1,
};

function completion(): Response {
  return new Response(
    JSON.stringify({
      id: "cmpl_1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

const pending: Promise<unknown>[] = [];

function chat(env: object): Promise<Response> {
  return chatCompletionsV2({
    request: new Request("https://gw.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local-m5/qwen-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    env: env as Env,
    apiKeyAuth,
    ctx: { waitUntil: (p) => void pending.push(p) },
  });
}

describe("chatCompletionsV2 with a vpc provider", () => {
  const globalFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetch);
    mockGetProviderConfig.mockResolvedValue(localBox);
    tenant.settings = {};
    pending.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the upstream call through the allowlisted binding", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(completion()) };

    const res = await chat({ VPC_BINDINGS: "HALOGEN:org_1", HALOGEN: binding });

    expect(res.status).toBe(200);
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    expect(binding.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:11435/v1/chat/completions",
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when the binding is not allowlisted", async () => {
    const binding = { fetch: vi.fn() };

    const res = await chat({ VPC_BINDINGS: "", HALOGEN: binding });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("not_configured");
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("returns not_configured when the binding belongs to another org", async () => {
    const binding = { fetch: vi.fn() };

    const res = await chat({
      VPC_BINDINGS: "HALOGEN:org_owner",
      HALOGEN: binding,
    });

    expect(res.status).toBe(400);
    expect(binding.fetch).not.toHaveBeenCalled();
  });
});

// [fork] W6: content retention is forced off for vpc providers.
describe("chatCompletionsV2 privacy for vpc providers", () => {
  const env = { VPC_BINDINGS: "HALOGEN:org_1", HALOGEN: { fetch: vi.fn() } };
  const traces: TraceEvent[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    traces.length = 0;
    pending.length = 0;
    setTraceCollector({ record: (event) => void traces.push(event) });
    env.HALOGEN.fetch.mockImplementation(async () => completion());
    tenant.settings = { cache: { enabled: true, ttl: 60 } };
  });
  afterEach(() => vi.unstubAllGlobals());

  it("never traces a vpc provider, even with settings.trace on", async () => {
    mockGetProviderConfig.mockResolvedValue({
      ...localBox,
      settings: { ...localBox.settings, trace: true },
    });

    const res = await chat(env);
    await res.text();
    await Promise.all(pending);

    expect(res.status).toBe(200);
    expect(traces).toEqual([]);
  });

  it("never reads or writes the response cache for a vpc provider", async () => {
    mockGetProviderConfig.mockResolvedValue(localBox);

    const res = await chat(env);
    await Promise.all(pending);

    expect(res.status).toBe(200);
    expect(vi.mocked(getCachedResponse)).not.toHaveBeenCalled();
    expect(vi.mocked(putCachedResponse)).not.toHaveBeenCalled();
  });

  it("still uses the tenant cache for a public provider", async () => {
    const globalFetch = vi.fn().mockImplementation(async () => completion());
    vi.stubGlobal("fetch", globalFetch);
    mockGetProviderConfig.mockResolvedValue({
      ...localBox,
      settings: { baseUrl: "https://llm.example.com" },
    });

    const res = await chat(env);
    await Promise.all(pending);

    expect(res.status).toBe(200);
    expect(vi.mocked(getCachedResponse)).toHaveBeenCalled();
  });
});
