// [fork] W13: /api/power endpoints.
import migration from "../../../migrations/0006_box_samples.sql?raw";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { powerRouter } from "~/src/api/power";
import type { AppBindings } from "~/src/app";
import type { SessionAuth } from "~/src/types";

const ORG = "org_pw";
const OTHER = "org_pw_other";
const NOW = Math.floor(Date.now() / 1000);
const T = NOW - (NOW % 600);
const HOUR = 3600;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);
CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));
CREATE TABLE IF NOT EXISTS tenant_settings (organization_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (organization_id, key));
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, timestamp INTEGER NOT NULL DEFAULT 0)
`;

const e = {
  ...env,
  VPC_BINDINGS: `HALOGEN:${ORG}`,
  HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}`,
  HALOGEN: { fetch: () => new Response("") },
  BOXSTATS: { fetch: () => new Response("") },
} as unknown as Env;

function app(org = ORG, role = "owner") {
  const a = new Hono<AppBindings>();
  a.use("*", async (c, next) => {
    c.set("session", {
      userId: "user_1",
      organizationId: org,
      role,
    } as SessionAuth);
    await next();
  });
  a.route("/api/power", powerRouter);
  return a;
}

async function call(
  path: string,
  init?: RequestInit,
  a: Hono<AppBindings> = app(),
) {
  const res = await a.request(path, init, e);
  return { status: res.status, body: (await res.json()) as any };
}

const put = (body: unknown, a?: Hono<AppBindings>) =>
  call(
    "/api/power/settings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    a,
  );

beforeAll(async () => {
  for (const stmt of SCHEMA.split(";")) {
    if (stmt.trim()) await env.DB.exec(stmt.replace(/\s+/g, " ").trim());
  }
  await env.DB.exec("DROP TABLE IF EXISTS host_samples");
  await env.DB.exec(
    migration
      .split(";")
      .map((s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim())
      .find((s) => s.startsWith("CREATE TABLE host_samples "))!,
  );
});

beforeEach(async () => {
  for (const t of [
    "host_samples",
    "request_metrics",
    "provider_configs",
    "tenant_settings",
    "audit_logs",
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await env.DB.prepare(
    "INSERT INTO provider_configs (id, organization_id, provider, config) VALUES ('p1', ?, 'local-m5', ?)",
  )
    .bind(
      ORG,
      JSON.stringify({
        keys: [],
        settings: { transport: "vpc", vpcBinding: "HALOGEN" },
      }),
    )
    .run();
  // 6 h of 10-minute rollups at 20 W ending at the current bucket.
  await env.DB.batch(
    Array.from({ length: 36 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO host_samples (binding, resolution_s, ts, ok, samples, gpu_power_w, gpu_power_w_max)
         VALUES ('BOXSTATS', 600, ?, 1, 60, 20, 45)`,
      ).bind(T - 6 * HOUR + i * 600),
    ),
  );
  await env.DB.prepare(
    `INSERT INTO request_metrics (id, organization_id, timestamp, provider, model, method, status_code,
       latency_ms, tokens_input, tokens_output, cache_hit)
     VALUES ('r1', ?, ?, 'local-m5', 'qwen', 'chat', 200, 100, 1000, 500, 0)`,
  )
    .bind(ORG, T - HOUR)
    .run();
});

const utcDays = (from: number, to: number) =>
  Math.floor((to - 1) / 86400) - Math.floor(from / 86400) + 1;

describe("GET /api/power", () => {
  it("report for a range ending in the future", async () => {
    await put({
      pricePerKwhUsd: 0.2,
      overheadW: 10,
      cloudReference: {
        inputPer1m: 1,
        outputPer1m: 4,
        cacheReadPer1m: 0,
        cacheWritePer1m: 0,
      },
    });
    const from = T - 6 * HOUR;
    const to = T + 6 * HOUR;
    const { status, body } = await call(`/api/power?from=${from}&to=${to}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ from, to, tz: "UTC", dataStart: from });
    expect(body.totals.coverage).toBeGreaterThan(0.9);
    expect(body.totals.coverage).toBeLessThanOrEqual(1);
    expect(body.totals.peakW).toBe(45);
    expect(body.totals.tokens.output).toBe(500);
    expect(body.totals.cloudUsd).toBeCloseTo((1000 * 1 + 500 * 4) / 1e6); // no cache tokens
    expect(body.days).toHaveLength(utcDays(from, to));
    expect(body.projectionUsd).toBeGreaterThan(body.totals.electricityUsd);
    expect(body.idleFloor).toEqual({
      watts: 30,
      monthlyUsd: ((30 * 730) / 1000) * 0.2,
    });
  });

  it("past range has no projection and honours tz", async () => {
    const { body } = await call(
      `/api/power?from=${T - 6 * HOUR}&to=${T - HOUR}&tz=Europe/Lisbon`,
    );
    expect(body.tz).toBe("Europe/Lisbon");
    expect(body.projectionUsd).toBeNull();
    expect(body.totals.electricityUsd).toBeNull();
  });

  it("org without host binding gets empty report", async () => {
    const { status, body } = await call(
      `/api/power?from=${T - HOUR}&to=${T}`,
      undefined,
      app(OTHER),
    );
    expect(status).toBe(200);
    expect(body.dataStart).toBeNull();
    expect(body.totals.totalKwh).toBe(0);
    expect(body.idleFloor).toBeNull();
  });

  it("rejects bad range and tz", async () => {
    for (const q of [
      "",
      `from=${T}&to=${T}`,
      `from=0&to=${401 * 86400}`,
      `from=${T - HOUR}&to=${T}&tz=Mars/Base`,
    ]) {
      expect((await call(`/api/power?${q}`)).status).toBe(400);
    }
  });
});

describe("GET /api/power/months", () => {
  it("months endpoint", async () => {
    await put({ pricePerKwhUsd: 0.2 });
    const { status, body } = await call("/api/power/months");
    expect(status).toBe(200);
    expect(body.months).toHaveLength(12);
    expect(body.months[0].start).toBeLessThan(body.months[11].start);
    expect(body.months[0]).toMatchObject({
      effectiveS: 0,
      coverage: null,
      electricityUsd: null,
      savingsUsd: null,
    });
    const current = body.months.find(
      (m: { start: number; end: number }) => m.start <= T && T < m.end,
    );
    // The 6 h of samples may straddle a month boundary; the months hold them all.
    const kwh = body.months.reduce(
      (s: number, m: { measuredKwh: number }) => s + m.measuredKwh,
      0,
    );
    expect(kwh).toBeCloseTo((20 * 6 * HOUR) / 3.6e6);
    expect(current.electricityUsd).not.toBeNull();
  });

  it("count and tz", async () => {
    const { body } = await call("/api/power/months?count=3&tz=Europe/Madrid");
    expect(body.months).toHaveLength(3);
    expect(body.tz).toBe("Europe/Madrid");
    for (const q of ["count=0", "count=25", "count=x", "tz=Nope/Nope"]) {
      expect((await call(`/api/power/months?${q}`)).status).toBe(400);
    }
  });
});

describe("/api/power/settings", () => {
  it("settings round trip", async () => {
    expect((await call("/api/power/settings")).body).toEqual({ power: {} });
    const saved = await put({ pricePerKwhUsd: 0.2, overheadW: 10 });
    expect(saved).toEqual({
      status: 200,
      body: { power: { pricePerKwhUsd: 0.2, overheadW: 10 } },
    });
    await put({ overheadW: null });
    expect((await call("/api/power/settings")).body).toEqual({
      power: { pricePerKwhUsd: 0.2 },
    });
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND resource_type = 'tenant'",
    )
      .bind(ORG)
      .first<{ n: number }>();
    expect(audit?.n).toBe(2);
  });

  it("rejects invalid bodies", async () => {
    expect((await put({ overheadW: 900 })).status).toBe(400);
    expect((await put("{not json")).status).toBe(400);
  });

  it("member cannot PUT settings", async () => {
    expect((await put({ pricePerKwhUsd: 1 }, app(ORG, "member"))).status).toBe(
      403,
    );
  });
});
