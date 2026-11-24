// [fork] W1/W3: chat completions with VPC providers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { chatCompletionsV2 } from "~/src/requests/chat_completions_v2";
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

function chat(
  env: object,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return chatCompletionsV2({
    request: new Request("https://gw.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local-m5/qwen-flash",
        messages: [{ role: "user", content: "hello" }],
        ...extra,
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

// [fork] W3: settings.injectBody shapes the outgoing request.
describe("chatCompletionsV2 injectBody", () => {
  const binding = { fetch: vi.fn() };
  const env = { VPC_BINDINGS: "HALOGEN:org_1", HALOGEN: binding };

  beforeEach(() => {
    vi.clearAllMocks();
    tenant.settings = {};
    mockGetProviderConfig.mockResolvedValue({
      ...localBox,
      settings: {
        ...localBox.settings,
        injectBody: {
          return_progress: true,
          stream_options: { include_usage: true },
        },
      },
    });
  });

  async function sentBody(extra: Record<string, unknown>) {
    binding.fetch.mockImplementation(async () =>
      extra.stream
        ? new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        : completion(),
    );
    const res = await chat(env, extra);
    await res.text();
    return JSON.parse(binding.fetch.mock.calls[0][1].body as string);
  }

  it("injects fields into a non-streaming request without stream_options", async () => {
    const body = await sentBody({});
    expect(body.return_progress).toBe(true);
    expect(body.stream_options).toBeUndefined();
    expect(body.model).toBe("qwen-flash");
  });

  it("injects stream_options.include_usage into a streaming request", async () => {
    const body = await sentBody({ stream: true });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("keeps the client's explicit values", async () => {
    const body = await sentBody({ return_progress: false });
    expect(body.return_progress).toBe(false);
  });
});
