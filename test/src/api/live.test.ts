// [fork] W11: GET /api/live.
import migration from "../../../migrations/0006_box_samples.sql?raw";
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
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, spend_disabled_until INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}');",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));",
  );
  await env.DB.prepare(
    "INSERT OR REPLACE INTO provider_configs (id, organization_id, provider, config) VALUES (?, ?, 'local-m5', ?)",
  )
    .bind(
      `${ORG}-local-m5`,
      ORG,
      JSON.stringify({
        keys: [],
        settings: { transport: "vpc", vpcBinding: "HALOGEN" },
      }),
    )
    .run();
  await env.DB.exec("DROP TABLE IF EXISTS inference_samples");
  await env.DB.exec("DROP TABLE IF EXISTS host_samples");
  await env.DB.exec("DROP TABLE IF EXISTS throughput_rollups");
  for (const table of [
    "inference_samples",
    "host_samples",
    "throughput_rollups",
  ]) {
    await env.DB.exec(
      migration
        .split(";")
        .map((x) => x.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim())
        .find((x) => x.startsWith(`CREATE TABLE ${table} `))!,
    );
  }
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
    expect(body.snapshot.throughput).toHaveLength(60);
    expect(body.snapshot.inference!.sampledAt).toBeGreaterThan(0);
    expect(body.snapshot.host!.sampledAt).toBeGreaterThan(0);
  });

  it("carries 60 throughput points and still makes one D1 batch", async () => {
    const spy = vi.spyOn(env.DB, "batch");
    const { body } = await get({ VPC_BINDINGS: `HALOGEN:${ORG}` });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const t = body.snapshot.throughput;
    expect(t).toHaveLength(60);
    expect(t[1].ts - t[0].ts).toBe(10);
    expect(Math.max(...t.map((p) => p.decodeTps))).toBeGreaterThan(0);
    expect(t.at(-1)!.ts).toBeGreaterThan(NOW - 10);
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
    expect(body.snapshot.throughput).toEqual([]);
  });

  it("requires a session", async () => {
    const res = await createApp().request("/api/live", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/live/history", () => {
  const history = (query: string, bindings: object = {}) =>
    app().request(`/api/live/history${query}`, {}, {
      ...env,
      VPC_BINDINGS: `HALOGEN:${ORG}`,
      HALOGEN: upstream({}),
      ...bindings,
    } as unknown as Env);

  it("returns the history for a valid range", async () => {
    const res = await history("?from=1000&to=2000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { from: number; bucketS: number };
    expect(body).toMatchObject({ from: 1000, bucketS: 10 });
  });

  it.each([
    ["missing to", "?from=1000"],
    ["missing from", "?to=1000"],
    ["non-integer", "?from=1.5&to=2000"],
    ["not a number", "?from=abc&to=2000"],
    ["from after to", "?from=2000&to=1000"],
    ["from equal to", "?from=2000&to=2000"],
    ["over 400 days", `?from=0&to=${500 * 86400}`],
  ])("rejects bad params: %s", async (_name, query) => {
    expect((await history(query)).status).toBe(400);
  });

  it("accepts exactly 400 days", async () => {
    expect((await history(`?from=0&to=${400 * 86400}`)).status).toBe(200);
  });
});

describe("GET /api/live/at", () => {
  const at = (query: string) =>
    app().request(`/api/live/at${query}`, {}, {
      ...env,
      VPC_BINDINGS: `HALOGEN:${ORG}`,
      HALOGEN: upstream({}),
    } as unknown as Env);

  it("uses the request start and the provider's binding", async () => {
    // Finished at NOW, 60 s latency -> started NOW - 60: the row near the
    // start must win over the one near the logged timestamp.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO request_metrics
         (id, organization_id, timestamp, provider, model, method, status_code, latency_ms, cache_hit)
       VALUES ('req_long', ?, ?, 'local-m5', 'qwen', 'chat', 200, 60000, 0)`,
    )
      .bind(ORG, NOW)
      .run();
    const ts = Math.round((NOW - 60) / 10) * 10;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO inference_samples (binding, resolution_s, ts, ok, in_flight) VALUES ('HALOGEN', 10, ?, 1, 3), ('HALOGEN', 10, ?, 1, 9)",
    )
      .bind(ts, Math.round(NOW / 10) * 10)
      .run();
    const res = await at("?request=req_long");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sample: {
        resolutionS: number;
        ts: number;
        inference: { in_flight: number };
      };
    };
    expect(body.sample).toMatchObject({
      resolutionS: 10,
      ts,
      inference: { in_flight: 3 },
    });
  });

  it("is null for a request that went to a cloud provider", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO request_metrics
         (id, organization_id, timestamp, provider, model, method, status_code, latency_ms, cache_hit)
       VALUES ('req_cloud', ?, ?, 'openai', 'gpt', 'chat', 200, 100, 0)`,
    )
      .bind(ORG, NOW)
      .run();
    const res = await at("?request=req_cloud");
    expect(await res.json()).toEqual({ sample: null });
  });

  it("404s for an unknown request or another org's", async () => {
    expect((await at("?request=nope")).status).toBe(404);
    expect((await at("")).status).toBe(404);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO request_metrics
         (id, organization_id, timestamp, provider, model, method, status_code, latency_ms, cache_hit)
       VALUES ('req_theirs', 'org_other', ?, 'local-m5', 'qwen', 'chat', 200, 100, 0)`,
    )
      .bind(NOW)
      .run();
    expect((await at("?request=req_theirs")).status).toBe(404);
  });
});
