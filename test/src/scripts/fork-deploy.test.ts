// [fork] W9: deploy-time options for VPC services, routes and pricing.
import {
  applyForkOptions,
  forkOptionsFromEnv,
  zeroPriceSql,
} from "../../../scripts/fork-deploy.mjs";
import { describe, expect, it } from "vitest";

const SERVICE_ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

function prod() {
  return {
    vars: { VPC_BINDINGS: "", LOG_LEVEL: "info" },
    workers_dev: true,
    preview_urls: false,
  } as Record<string, unknown> & { vars: Record<string, string> };
}

describe("applyForkOptions", () => {
  it("leaves the config untouched without fork options", () => {
    const p = prod();
    const out = applyForkOptions(p, {});
    expect(p).toEqual(prod());
    expect(out.warnings).toEqual([]);
  });

  it("injects VPC services and the org-scoped allowlist", () => {
    const p = prod();
    const out = applyForkOptions(p, {
      vpcServiceIds: [`HALOGEN=${SERVICE_ID}`],
      vpcAllow: ["HALOGEN=org_abc|org_def"],
    });
    expect(p.vpc_services).toEqual([
      { binding: "HALOGEN", service_id: SERVICE_ID, remote: true },
    ]);
    expect(p.vars.VPC_BINDINGS).toBe("HALOGEN:org_abc|org_def");
    expect(out.warnings).toEqual([]);
  });

  it("warns and allows nobody when a service has no --vpc-allow", () => {
    const p = prod();
    const out = applyForkOptions(p, {
      vpcServiceIds: [`HALOGEN=${SERVICE_ID}`],
    });
    expect(p.vars.VPC_BINDINGS).toBe("HALOGEN");
    expect(out.warnings[0]).toContain("HALOGEN");
  });

  it("accepts * to allow every organization", () => {
    const p = prod();
    applyForkOptions(p, {
      vpcServiceIds: [`HALOGEN=${SERVICE_ID}`],
      vpcAllow: ["HALOGEN=*"],
    });
    expect(p.vars.VPC_BINDINGS).toBe("HALOGEN:*");
  });

  it.each([
    [{ vpcServiceIds: ["halogen=" + SERVICE_ID] }, "binding name"],
    [{ vpcServiceIds: ["HALOGEN=not-a-uuid"] }, "service id"],
    [{ vpcServiceIds: ["HALOGEN"] }, "NAME=ID"],
    [
      { vpcServiceIds: [`HALOGEN=${SERVICE_ID}`, `HALOGEN=${SERVICE_ID}`] },
      "twice",
    ],
    [
      { vpcServiceIds: [`HALOGEN=${SERVICE_ID}`], vpcAllow: ["OTHER=org_a"] },
      "unknown VPC service",
    ],
    [
      {
        vpcServiceIds: [`HALOGEN=${SERVICE_ID}`],
        vpcAllow: ["HALOGEN=org a"],
      },
      "organization id",
    ],
    [
      {
        vpcServiceIds: [`HALOGEN=${SERVICE_ID}`],
        vpcAllow: ["HALOGEN=org_a,OTHER:*"],
      },
      "organization id",
    ],
  ])("rejects %j", (options, message) => {
    expect(() => applyForkOptions(prod(), options)).toThrow(message);
  });

  it("routes a custom domain and turns off workers.dev and previews", () => {
    const p = prod();
    applyForkOptions(p, { customDomain: "api.example.com" });
    expect(p.routes).toEqual([
      { pattern: "api.example.com", custom_domain: true },
    ]);
    expect(p.workers_dev).toBe(false);
    expect(p.preview_urls).toBe(false);
  });

  it.each(["https://api.example.com", "api.example.com/*", "localhost"])(
    "rejects custom domain %s",
    (customDomain) => {
      expect(() => applyForkOptions(prod(), { customDomain })).toThrow(
        "custom domain",
      );
    },
  );
});

describe("zeroPriceSql", () => {
  it("prices every model of a provider at zero", () => {
    expect(zeroPriceSql("local-m5")).toBe(
      "INSERT OR REPLACE INTO model_pricing (provider, model, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m) VALUES ('local-m5', '*', 0, 0, 0, 0);",
    );
  });

  it.each(["Local", "x'; DROP TABLE users; --", ""])(
    "rejects provider id %j",
    (provider) => {
      expect(() => zeroPriceSql(provider)).toThrow("provider id");
    },
  );
});

describe("forkOptionsFromEnv", () => {
  const EMPTY_FLAGS = {
    "vpc-service-id": undefined,
    "vpc-allow": undefined,
    "custom-domain": undefined,
    "zero-price-provider": undefined,
    "host-metrics": undefined,
  };

  it("returns no options when neither flags nor env are set", () => {
    expect(forkOptionsFromEnv(EMPTY_FLAGS, {})).toEqual({
      vpcServiceIds: [],
      vpcAllow: [],
      customDomain: undefined,
      zeroPriceProviders: [],
      hostMetrics: [],
    });
  });

  it("reads comma-separated lists and the domain from env", () => {
    const out = forkOptionsFromEnv(EMPTY_FLAGS, {
      VPC_SERVICE_IDS: `HALOGEN=${SERVICE_ID}, OTHER=${SERVICE_ID}`,
      VPC_ALLOW: "HALOGEN=org_a|org_b,OTHER=*",
      CUSTOM_DOMAIN: " api.example.com ",
      ZERO_PRICE_PROVIDERS: "local-m5,,other",
      HOST_METRICS: "BOXSTATS=org_a, OTHER=*",
    });
    expect(out).toEqual({
      vpcServiceIds: [`HALOGEN=${SERVICE_ID}`, `OTHER=${SERVICE_ID}`],
      vpcAllow: ["HALOGEN=org_a|org_b", "OTHER=*"],
      customDomain: "api.example.com",
      zeroPriceProviders: ["local-m5", "other"],
      hostMetrics: ["BOXSTATS=org_a", "OTHER=*"],
    });
  });

  it("prefers flags over env, per option", () => {
    const out = forkOptionsFromEnv(
      {
        ...EMPTY_FLAGS,
        "custom-domain": "flag.example.com",
        "zero-price-provider": ["flag-provider"],
      },
      {
        CUSTOM_DOMAIN: "env.example.com",
        ZERO_PRICE_PROVIDERS: "env-provider",
        VPC_ALLOW: "HALOGEN=org_env",
      },
    );
    expect(out.customDomain).toBe("flag.example.com");
    expect(out.zeroPriceProviders).toEqual(["flag-provider"]);
    expect(out.vpcAllow).toEqual(["HALOGEN=org_env"]);
  });

  it("treats a blank CUSTOM_DOMAIN as unset", () => {
    expect(
      forkOptionsFromEnv(EMPTY_FLAGS, { CUSTOM_DOMAIN: "  " }).customDomain,
    ).toBeUndefined();
  });
});

// [fork] W11: host metrics bindings for the live monitor.
describe("applyForkOptions host metrics", () => {
  it("host-metrics services go to HOST_METRICS_BINDINGS, not VPC_BINDINGS", () => {
    const p = prod();
    const out = applyForkOptions(p, {
      vpcServiceIds: [`HALOGEN=${SERVICE_ID}`, `BOXSTATS=${SERVICE_ID}`],
      vpcAllow: ["HALOGEN=org_1"],
      hostMetrics: ["BOXSTATS=org_1"],
    });
    expect(p.vpc_services).toEqual([
      { binding: "HALOGEN", service_id: SERVICE_ID, remote: true },
      { binding: "BOXSTATS", service_id: SERVICE_ID, remote: true },
    ]);
    expect(p.vars.VPC_BINDINGS).toBe("HALOGEN:org_1");
    expect(p.vars.HOST_METRICS_BINDINGS).toBe("BOXSTATS:org_1");
    expect(out.warnings).toEqual([]);
  });

  it("rejects --host-metrics for an unbound service", () => {
    expect(() =>
      applyForkOptions(prod(), {
        vpcServiceIds: [`HALOGEN=${SERVICE_ID}`],
        hostMetrics: ["BOXSTATS=org_1"],
      }),
    ).toThrow(/BOXSTATS/);
  });

  it("rejects a name in both --vpc-allow and --host-metrics", () => {
    expect(() =>
      applyForkOptions(prod(), {
        vpcServiceIds: [`BOXSTATS=${SERVICE_ID}`],
        vpcAllow: ["BOXSTATS=org_1"],
        hostMetrics: ["BOXSTATS=org_1"],
      }),
    ).toThrow(/BOXSTATS/);
  });

  it("rejects an invalid organization id", () => {
    expect(() =>
      applyForkOptions(prod(), {
        vpcServiceIds: [`BOXSTATS=${SERVICE_ID}`],
        hostMetrics: ["BOXSTATS=org 1"],
      }),
    ).toThrow(/--host-metrics/);
  });

  it("forkOptionsFromEnv prefers the --host-metrics flag over HOST_METRICS", () => {
    const out = forkOptionsFromEnv(
      { "host-metrics": ["BOXSTATS=org_flag"] },
      { HOST_METRICS: "BOXSTATS=org_env" },
    );
    expect(out.hostMetrics).toEqual(["BOXSTATS=org_flag"]);
  });
});
