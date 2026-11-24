import { describe, expect, it } from "vitest";
import {
  assertVpcUrl,
  isPrivateTransport,
  resolveFetcher,
} from "~/src/llm/transport";
import { TransportNotConfiguredError } from "~/src/llm/transport-error";

const binding = { fetch: async () => new Response("ok") };
const ORG = "org_owner";
const vpc = {
  transport: "vpc",
  vpcBinding: "HALOGEN",
  baseUrl: "http://127.0.0.1:11435",
};
const env = { VPC_BINDINGS: `HALOGEN:${ORG}`, HALOGEN: binding };

function expectNotConfigured(fn: () => unknown, message: string) {
  expect(fn).toThrow(TransportNotConfiguredError);
  expect(fn).toThrow(message);
}

describe("resolveFetcher", () => {
  it("returns undefined when settings are missing", () => {
    expect(resolveFetcher(env, undefined, ORG)).toBe(undefined);
  });

  it("returns undefined for the public transport", () => {
    expect(resolveFetcher(env, { ...vpc, transport: "public" }, ORG)).toBe(
      undefined,
    );
  });

  it("returns undefined when no transport is set", () => {
    expect(resolveFetcher(env, { baseUrl: "x" }, ORG)).toBe(undefined);
  });

  it("returns the binding when the org is allowlisted for it", () => {
    expect(
      resolveFetcher(
        {
          VPC_BINDINGS: ` OTHER:org_x , HALOGEN:org_y|${ORG} `,
          HALOGEN: binding,
        },
        vpc,
        ORG,
      ),
    ).toBe(binding);
  });

  it("allows every org when the binding is listed with *", () => {
    expect(
      resolveFetcher({ VPC_BINDINGS: "HALOGEN:*", HALOGEN: binding }, vpc, ORG),
    ).toBe(binding);
  });

  it("rejects an org that is not listed for the binding", () => {
    expectNotConfigured(
      () => resolveFetcher(env, vpc, "org_intruder"),
      "not allowed",
    );
  });

  it("rejects a bare binding name with no org list", () => {
    expectNotConfigured(
      () =>
        resolveFetcher({ VPC_BINDINGS: "HALOGEN", HALOGEN: binding }, vpc, ORG),
      "not allowed",
    );
  });

  it("rejects a binding that is not listed at all", () => {
    expectNotConfigured(
      () =>
        resolveFetcher(
          { ...env, DB: binding },
          { ...vpc, vpcBinding: "DB" },
          ORG,
        ),
      "not allowed",
    );
  });

  it("rejects when the allowlist is unset", () => {
    expectNotConfigured(
      () => resolveFetcher({ HALOGEN: binding }, vpc, ORG),
      "not allowed",
    );
  });

  it("rejects a vpc transport without vpcBinding", () => {
    expectNotConfigured(
      () => resolveFetcher(env, { ...vpc, vpcBinding: undefined }, ORG),
      "vpcBinding is required",
    );
  });

  it("rejects an allowlisted binding that is absent from env", () => {
    expectNotConfigured(
      () => resolveFetcher({ VPC_BINDINGS: `HALOGEN:${ORG}` }, vpc, ORG),
      "not bound",
    );
  });

  it("rejects an env value that cannot fetch", () => {
    expectNotConfigured(
      () =>
        resolveFetcher(
          { VPC_BINDINGS: `HALOGEN:${ORG}`, HALOGEN: "nope" },
          vpc,
          ORG,
        ),
      "not bound",
    );
  });

  it("rejects a base URL with a path", () => {
    expectNotConfigured(
      () =>
        resolveFetcher(
          env,
          { ...vpc, baseUrl: "http://127.0.0.1:11435/admin" },
          ORG,
        ),
      "baseUrl",
    );
  });

  it("rejects a base URL that does not parse", () => {
    expectNotConfigured(
      () => resolveFetcher(env, { ...vpc, baseUrl: "not a url" }, ORG),
      "baseUrl",
    );
  });

  it("accepts a base URL with a trailing slash", () => {
    expect(
      resolveFetcher(env, { ...vpc, baseUrl: "http://127.0.0.1:11435/" }, ORG),
    ).toBe(binding);
  });

  it.each([
    ["chatCompletionPath", "/admin/shutdown"],
    ["modelsPath", "/v1/models/../../admin"],
    ["embeddingsPath", "/v1/embeddings?x=1"],
    ["chatCompletionPath", "/v1/chat/completions/extra"],
  ])("rejects %s = %s", (key, value) => {
    expectNotConfigured(
      () => resolveFetcher(env, { ...vpc, [key]: value }, ORG),
      key,
    );
  });

  it.each([
    "http://127.0.0.1:11435/?x=1",
    "http://127.0.0.1:11435/#frag",
    "http://user:pw@127.0.0.1:11435",
  ])("rejects base URL %s", (baseUrl) => {
    expectNotConfigured(
      () => resolveFetcher(env, { ...vpc, baseUrl }, ORG),
      "baseUrl",
    );
  });

  it("accepts explicit /v1/ paths", () => {
    expect(
      resolveFetcher(
        env,
        {
          ...vpc,
          chatCompletionPath: "/v1/chat/completions",
          modelsPath: "/v1/models",
        },
        ORG,
      ),
    ).toBe(binding);
  });

  it("carries the not_configured code on the error", () => {
    try {
      resolveFetcher({}, vpc, ORG);
      expect.unreachable();
    } catch (err) {
      expect((err as TransportNotConfiguredError).code).toBe("not_configured");
    }
  });
});

describe("isPrivateTransport", () => {
  it("is true only for the vpc transport", () => {
    expect(isPrivateTransport({ transport: "vpc" })).toBe(true);
    expect(isPrivateTransport({ transport: "public" })).toBe(false);
    expect(isPrivateTransport({})).toBe(false);
    expect(isPrivateTransport(undefined)).toBe(false);
  });
});

describe("assertVpcUrl", () => {
  it.each([
    "http://127.0.0.1:11435/v1/chat/completions",
    "http://127.0.0.1:11435/v1/models",
    "http://127.0.0.1:11435/v1/embeddings",
  ])("accepts %s", (url) => {
    expect(() => assertVpcUrl(url)).not.toThrow();
  });

  it.each([
    "http://127.0.0.1:11435/chat/completions",
    "http://127.0.0.1:11435/v1/admin",
    "http://127.0.0.1:11435/v1/models?x=1",
    "http://127.0.0.1:11435/v1/models#x",
    "http://127.0.0.1:11435/v1/%2e%2e/admin",
    "http://127.0.0.1:11435/v1/%2fadmin",
    "http://127.0.0.1:11435//v1/models",
    "http://127.0.0.1:11435/v1\\..\\admin",
    "http://u:p@127.0.0.1:11435/v1/models",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertVpcUrl(url)).toThrow(TransportNotConfiguredError);
  });
});
