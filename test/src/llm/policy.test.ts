import { describe, it, expect } from "vitest";
import {
  assertModelAllowed,
  assertProviderAllowed,
  assertTenantActive,
  isModelAllowed,
} from "~/src/llm/policy";
import type { TenantSettings } from "~/src/db/tenant";
import type { ApiKeyScopes } from "~/src/types";

describe("assertTenantActive", () => {
  it("allows active tenants", () => {
    expect(assertTenantActive({} as TenantSettings)).toBeUndefined();
  });

  it("blocks suspended tenants", () => {
    const err = assertTenantActive({ status: "suspended" } as TenantSettings);
    expect(err?.code).toBe("tenant_suspended");
    expect(err?.status).toBe(403);
  });
});

describe("assertProviderAllowed", () => {
  it("allows when scopes have no provider list", () => {
    expect(assertProviderAllowed({}, undefined, "openai")).toBeUndefined();
  });

  it("allows matching providers", () => {
    const scopes: ApiKeyScopes = { providers: ["openai", "anthropic"] };
    expect(assertProviderAllowed({}, scopes, "openai")).toBeUndefined();
  });

  it("blocks non-listed providers", () => {
    const scopes: ApiKeyScopes = { providers: ["openai"] };
    const err = assertProviderAllowed({}, scopes, "anthropic");
    expect(err?.code).toBe("provider_not_allowed");
  });
});

describe("isModelAllowed", () => {
  it("allows everything when all lists are empty", () => {
    expect(isModelAllowed([undefined], "openai", "gpt-4o")).toBe(true);
    expect(isModelAllowed([[]], "openai", "gpt-4o")).toBe(true);
  });

  it("matches bare entries against model id", () => {
    expect(isModelAllowed([["gpt-4o", "claude-3-5-sonnet"]], "openai", "gpt-4o")).toBe(
      true,
    );
    expect(isModelAllowed([["gpt-4o"]], "anthropic", "gpt-4o")).toBe(true);
  });

  it("matches qualified entries case-insensitively", () => {
    expect(isModelAllowed([["OpenAI/gpt-4o"]], "openai", "gpt-4o")).toBe(true);
  });

  it("requires every configured list to match", () => {
    expect(
      isModelAllowed(
        [["gpt-4o"], ["gpt-4o"]],
        "openai",
        "gpt-4o",
      ),
    ).toBe(true);
    expect(
      isModelAllowed(
        [["gpt-4o"], ["claude-3-5-sonnet"]],
        "openai",
        "gpt-4o",
      ),
    ).toBe(false);
  });
});

describe("assertModelAllowed", () => {
  it("blocks models outside the tenant allowlist", () => {
    const settings = { modelAllowlist: ["openai/gpt-4o"] } as TenantSettings;
    const err = assertModelAllowed(settings, undefined, "openai", "gpt-4o-mini");
    expect(err?.code).toBe("model_not_allowed");
  });

  it("blocks models outside per-key scopes", () => {
    const scopes: ApiKeyScopes = { models: ["gpt-4o"] };
    const err = assertModelAllowed({}, scopes, "openai", "gpt-4o-mini");
    expect(err?.code).toBe("model_not_allowed");
  });
});