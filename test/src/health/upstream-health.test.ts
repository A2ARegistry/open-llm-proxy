// [fork] W7: box health for VPC upstreams.
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { healthRouter } from "~/src/api/health";
import type { AppBindings } from "~/src/app";
import {
  checkUpstreams,
  readUpstreamHealth,
} from "~/src/health/upstream-health";
import { vpcBindingNames } from "~/src/llm/transport";
import type { SessionAuth } from "~/src/types";

const ORG = "org_health";

function healthy() {
  return {
    fetch: vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ status: "ok", version: "0.20.5" })),
      ),
  };
}

function envWith(bindings: Record<string, unknown>, allowlist: string) {
  return { ...env, VPC_BINDINGS: allowlist, ...bindings } as unknown as Env;
}

beforeEach(async () => {
  for (const name of ["HALOGEN", "OTHER"]) {
    await env.SESSION_CACHE.delete(`health:${name}`);
  }
});

describe("vpcBindingNames", () => {
  it("lists every configured binding, or only those an org may use", () => {
    const e = { VPC_BINDINGS: `HALOGEN:${ORG}, OTHER:org_x, ALL:*` };
    expect(vpcBindingNames(e)).toEqual(["HALOGEN", "OTHER", "ALL"]);
    expect(vpcBindingNames(e, ORG)).toEqual(["HALOGEN", "ALL"]);
    expect(vpcBindingNames({ VPC_BINDINGS: "" })).toEqual([]);
    expect(vpcBindingNames({})).toEqual([]);
  });
});

describe("checkUpstreams", () => {
  it("records a healthy upstream with its version and latency", async () => {
    const binding = healthy();
    await checkUpstreams(envWith({ HALOGEN: binding }, `HALOGEN:${ORG}`));

    expect(binding.fetch.mock.calls[0][0]).toBe("http://vpc.internal/health");
    const [entry] = await readUpstreamHealth(
      envWith({}, `HALOGEN:${ORG}`),
      ORG,
    );
    expect(entry).toMatchObject({
      binding: "HALOGEN",
      status: "ok",
      version: "0.20.5",
    });
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry.checkedAt).toBeGreaterThan(0);
  });

  it("records down when the upstream answers with an error", async () => {
    const binding = {
      fetch: vi.fn().mockResolvedValue(new Response("no", { status: 502 })),
    };
    await checkUpstreams(envWith({ HALOGEN: binding }, `HALOGEN:${ORG}`));
    const [entry] = await readUpstreamHealth(
      envWith({}, `HALOGEN:${ORG}`),
      ORG,
    );
    expect(entry).toMatchObject({ status: "down", version: null });
  });

  it("records down when the upstream reports a non-ok status", async () => {
    const binding = {
      fetch: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ status: "loading" }))),
    };
    await checkUpstreams(envWith({ HALOGEN: binding }, `HALOGEN:${ORG}`));
    const [entry] = await readUpstreamHealth(
      envWith({}, `HALOGEN:${ORG}`),
      ORG,
    );
    expect(entry.status).toBe("down");
  });

  it("records down when the fetch fails or the binding is missing", async () => {
    const failing = {
      fetch: vi.fn().mockRejectedValue(new Error("tunnel down")),
    };
    await checkUpstreams(
      envWith({ HALOGEN: failing }, `HALOGEN:${ORG},OTHER:${ORG}`),
    );
    const entries = await readUpstreamHealth(
      envWith({}, `HALOGEN:${ORG},OTHER:${ORG}`),
      ORG,
    );
    expect(entries.map((e) => [e.binding, e.status])).toEqual([
      ["HALOGEN", "down"],
      ["OTHER", "down"],
    ]);
  });
});

describe("readUpstreamHealth", () => {
  it("reports unknown before the first check", async () => {
    const entries = await readUpstreamHealth(
      envWith({}, `HALOGEN:${ORG}`),
      ORG,
    );
    expect(entries).toEqual([
      {
        binding: "HALOGEN",
        status: "unknown",
        version: null,
        checkedAt: null,
        latencyMs: null,
      },
    ]);
  });

  it("hides bindings the org may not use", async () => {
    await checkUpstreams(envWith({ OTHER: healthy() }, "OTHER:org_x"));
    expect(await readUpstreamHealth(envWith({}, "OTHER:org_x"), ORG)).toEqual(
      [],
    );
  });
});

describe("GET /api/health/upstreams", () => {
  it("returns the org's upstream health", async () => {
    const session = { organizationId: ORG } as SessionAuth;
    const app = new Hono<AppBindings>();
    app.use("*", (c, next) => {
      c.set("session", session);
      return next();
    });
    app.route("/api/health", healthRouter);

    const res = await app.request(
      "/api/health/upstreams",
      {},
      envWith({}, `HALOGEN:${ORG}`),
    );
    const body = (await res.json()) as { upstreams: { binding: string }[] };

    expect(res.status).toBe(200);
    expect(body.upstreams.map((u) => u.binding)).toEqual(["HALOGEN"]);
  });
});
