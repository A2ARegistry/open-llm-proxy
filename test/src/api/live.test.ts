// [fork] W11: GET /api/live.
import halogenHealth from "../../fixtures/live/halogen-health.json?raw";
import halogenMetrics from "../../fixtures/live/halogen-metrics.txt?raw";
import nodeMetrics from "../../fixtures/live/node-exporter-metrics.txt?raw";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { liveRouter } from "~/src/api/live";
import type { AppBindings } from "~/src/app";
import { createApp } from "~/src/app";
import type { LiveSnapshot } from "~/src/live/snapshot";
import type { SessionAuth } from "~/src/types";

const ORG = "org_live";
const NOW = Math.floor(Date.now() / 1000);

function upstream(routes: Record<string, string>) {
  return {
    fetch: vi.fn(async (url: string) => {
      const body = routes[new URL(url).pathname];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body);
    }),
  };
}

function down() {
  return { fetch: vi.fn().mockRejectedValue(new Error("tunnel down")) };
}

function app() {
  const a = new Hono<AppBindings>();
  a.use("*", async (c, next) => {
    c.set("session", { organizationId: ORG } as SessionAuth);
    await next();
  });
  a.route("/api/live", liveRouter);
  return a;
}

async function get(bindings: Record<string, unknown>) {
  const res = await app().request("/api/live", {}, {
    ...env,
    ...bindings,
  } as unknown as Env);
  return { res, body: (await res.json()) as { snapshot: LiveSnapshot } };
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO request_metrics
         (id, organization_id, api_key_id, timestamp, provider, model, method,
          status_code, latency_ms, tokens_input, tokens_output, cost_usd, cache_hit,
          ttft_ms, decode_ms)
       VALUES (?, ?, NULL, ?, 'local-m5', 'qwen', 'chat', 200, 900, 29, 680, 0, 0, 448, 40000)`,
    ).bind("req_live_old", ORG, NOW - 60),
    env.DB.prepare(
      `INSERT INTO request_metrics
         (id, organization_id, api_key_id, timestamp, provider, model, method,
          status_code, latency_ms, tokens_input, tokens_output, cost_usd, cache_hit,
          ttft_ms, decode_ms)
       VALUES (?, ?, NULL, ?, 'local-m5', 'qwen', 'chat', 200, 900, 31, 700, 0, 0, 450, 41000)`,
    ).bind("req_live_new", ORG, NOW - 5),
  ]);
});

describe("GET /api/live", () => {
  it("returns a full snapshot", async () => {
    const { res, body } = await get({
      VPC_BINDINGS: `HALOGEN:${ORG}`,
      HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}`,
      HALOGEN: upstream({
        "/health": halogenHealth,
        "/metrics": halogenMetrics,
      }),
      BOXSTATS: upstream({ "/metrics": nodeMetrics }),
    });
    expect(res.status).toBe(200);
    expect(body.snapshot.inference?.binding).toBe("HALOGEN");
    expect(body.snapshot.inference?.slots).not.toBeNull();
    expect(body.snapshot.host?.binding).toBe("BOXSTATS");
    expect(body.snapshot.host?.gpuTempC).not.toBeNull();
    expect(body.snapshot.lastRequest?.id).toBe("req_live_new");
    expect(body.snapshot.lastRequest?.ttft_ms).toBe(450);
    expect(body.snapshot.at).toBeGreaterThan(0);
    expect(body.snapshot.inference!.sampledAt).toBeGreaterThan(0);
    expect(body.snapshot.host!.sampledAt).toBeGreaterThan(0);
  });

  it("box down still answers 200", async () => {
    const { res, body } = await get({
      VPC_BINDINGS: `HALOGEN:${ORG}`,
      HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}`,
      HALOGEN: down(),
      BOXSTATS: down(),
    });
    expect(res.status).toBe(200);
    expect(body.snapshot.inference).toBeNull();
    expect(body.snapshot.host).toBeNull();
    expect(body.snapshot.lastRequest?.id).toBe("req_live_new");
  });

  it("org without host access gets no host metrics", async () => {
    const box = upstream({ "/metrics": nodeMetrics });
    const { body } = await get({
      VPC_BINDINGS: "",
      HOST_METRICS_BINDINGS: "BOXSTATS:org_other",
      BOXSTATS: box,
    });
    expect(body.snapshot.host).toBeNull();
    expect(body.snapshot.inference).toBeNull();
    expect(box.fetch).not.toHaveBeenCalled();
  });

  it("an org with no requests gets lastRequest null", async () => {
    const res = await new Hono<AppBindings>()
      .use("*", async (c, next) => {
        c.set("session", { organizationId: "org_empty" } as SessionAuth);
        await next();
      })
      .route("/api/live", liveRouter)
      .request("/api/live", {}, env);
    const body = (await res.json()) as { snapshot: LiveSnapshot };
    expect(body.snapshot.lastRequest).toBeNull();
  });

  it("requires a session", async () => {
    const res = await createApp().request("/api/live", {}, env);
    expect(res.status).toBe(401);
  });
});
