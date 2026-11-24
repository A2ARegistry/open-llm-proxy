import { describe, expect, it } from "vitest";
import { resolveFetcher } from "~/src/llm/transport";
import { TransportNotConfiguredError } from "~/src/llm/transport-error";

const binding = { fetch: async () => new Response("ok") };

describe("resolveFetcher", () => {
  it("returns undefined when settings are missing", () => {
    expect(resolveFetcher({ VPC_BINDINGS: "HALOGEN" }, undefined)).toBe(
      undefined,
    );
  });

  it("returns undefined for the public transport", () => {
    expect(
      resolveFetcher(
        { VPC_BINDINGS: "HALOGEN", HALOGEN: binding },
        { transport: "public", vpcBinding: "HALOGEN" },
      ),
    ).toBe(undefined);
  });

  it("returns undefined when no transport is set", () => {
    expect(resolveFetcher({ HALOGEN: binding }, { baseUrl: "x" })).toBe(
      undefined,
    );
  });

  it("returns the allowlisted binding for the vpc transport", () => {
    expect(
      resolveFetcher(
        { VPC_BINDINGS: " OTHER , HALOGEN ", HALOGEN: binding },
        { transport: "vpc", vpcBinding: "HALOGEN" },
      ),
    ).toBe(binding);
  });

  it("throws not_configured when the binding is not allowlisted", () => {
    expect(() =>
      resolveFetcher(
        { VPC_BINDINGS: "HALOGEN", DB: binding },
        { transport: "vpc", vpcBinding: "DB" },
      ),
    ).toThrow(TransportNotConfiguredError);
  });

  it("throws not_configured when the allowlist is unset", () => {
    expect(() =>
      resolveFetcher(
        { HALOGEN: binding },
        { transport: "vpc", vpcBinding: "HALOGEN" },
      ),
    ).toThrow(TransportNotConfiguredError);
  });

  it("throws not_configured when vpcBinding is missing", () => {
    expect(() =>
      resolveFetcher(
        { VPC_BINDINGS: "HALOGEN", HALOGEN: binding },
        { transport: "vpc" },
      ),
    ).toThrow(TransportNotConfiguredError);
  });

  it("throws not_configured when the allowlisted binding is absent from env", () => {
    expect(() =>
      resolveFetcher(
        { VPC_BINDINGS: "HALOGEN" },
        { transport: "vpc", vpcBinding: "HALOGEN" },
      ),
    ).toThrow(TransportNotConfiguredError);
  });

  it("throws not_configured when the env value cannot fetch", () => {
    expect(() =>
      resolveFetcher(
        { VPC_BINDINGS: "HALOGEN", HALOGEN: "not-a-binding" },
        { transport: "vpc", vpcBinding: "HALOGEN" },
      ),
    ).toThrow(TransportNotConfiguredError);
  });

  it("carries the not_configured code on the error", () => {
    try {
      resolveFetcher({}, { transport: "vpc", vpcBinding: "HALOGEN" });
      expect.unreachable();
    } catch (err) {
      expect((err as TransportNotConfiguredError).code).toBe("not_configured");
    }
  });
});
