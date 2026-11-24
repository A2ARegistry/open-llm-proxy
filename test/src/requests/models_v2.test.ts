// [fork] W1: /v1/models reaches VPC providers through their binding.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProviderConfigs } from "~/src/llm/credential-store";
import type { DecryptedProviderConfig } from "~/src/llm/credential-store";
import { modelsV2 } from "~/src/requests/models_v2";
import type { ApiKeyAuth } from "~/src/types";

vi.mock("~/src/db/tenant", () => ({
  TenantService: class {
    async getSettings() {
      return {};
    }
  },
}));

vi.mock("~/src/llm/credential-store", () => ({
  listProviderConfigs: vi.fn(),
}));

const mockListProviderConfigs = vi.mocked(listProviderConfigs);

const apiKeyAuth = {
  keyId: "key_1",
  organizationId: "org_1",
  scopes: {},
} as unknown as ApiKeyAuth;

function localBox(settings: Record<string, unknown>): DecryptedProviderConfig {
  return {
    id: "pcfg_local",
    provider: "local-m5",
    name: "local-m5",
    enabled: true,
    keys: [],
    settings: {
      baseUrl: "http://127.0.0.1:11435",
      modelsPath: "/v1/models",
      ...settings,
    },
    updatedAt: 1,
  };
}

async function listedIds(env: object): Promise<string[]> {
  const res = await modelsV2({ env: env as Env, apiKeyAuth });
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => m.id);
}

describe("modelsV2 with a vpc provider", () => {
  const globalFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", globalFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists the box's models through the allowlisted binding", async () => {
    mockListProviderConfigs.mockResolvedValue([
      localBox({ transport: "vpc", vpcBinding: "HALOGEN" }),
    ]);
    const binding = {
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: [{ id: "qwen-flash" }] })),
        ),
    };

    const ids = await listedIds({ VPC_BINDINGS: "HALOGEN", HALOGEN: binding });

    expect(ids).toEqual(["local-m5/qwen-flash"]);
    expect(binding.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:11435/v1/models",
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("skips a vpc provider whose binding is not allowlisted", async () => {
    mockListProviderConfigs.mockResolvedValue([
      localBox({ transport: "vpc", vpcBinding: "DB", customModels: ["x"] }),
    ]);

    const ids = await listedIds({ VPC_BINDINGS: "HALOGEN", DB: {} });

    expect(ids).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
