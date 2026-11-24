// [fork] W9: deploy-time options for VPC services, routes and pricing.
import {
  applyForkOptions,
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
