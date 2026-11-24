// [fork] W1: chat completions reach VPC providers through their binding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderConfig } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { chatCompletionsV2 } from "~/src/requests/chat_completions_v2";
import type { ApiKeyAuth } from "~/src/types";

vi.mock("~/src/db/tenant", () => ({
  TenantService: class {
    async getSettings() {
      return {};
    }
  },
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
    ctx: { waitUntil: () => undefined },
  });
}

describe("chatCompletionsV2 with a vpc provider", () => {
  const globalFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetch);
    mockGetProviderConfig.mockResolvedValue(localBox);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the upstream call through the allowlisted binding", async () => {
    const binding = { fetch: vi.fn().mockResolvedValue(completion()) };

    const res = await chat({ VPC_BINDINGS: "HALOGEN", HALOGEN: binding });

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
});
