import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { metricsRouter } from "~/src/api/metrics";
import type { AppBindings } from "~/src/app";
import { cacheUsageByModel, spendForRange } from "~/src/metrics/cost-tracker";
import type { SessionAuth } from "~/src/types";

const ORG = "org_cache_metrics";

const session: SessionAuth = {
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: ORG,
  role: "owner",
  email: "owner@acme.test",
  expiresAt: 9999999999,
};

const NOW = Math.floor(Date.now() / 1000);
const START = NOW - 3600;
const END = NOW + 60;

function uniq(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface SeedMetric {
  provider?: string;
  model?: string;
  statusCode?: number;
  tokensInput?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  cacheHit?: number;
  costUsd?: number | null;
}

async function seed(m: SeedMetric) {
  await env.DB.prepare(
    `INSERT INTO request_metrics
       (id, organization_id, timestamp, provider, model, method, status_code,
        latency_ms, tokens_input, tokens_output, tokens_cached,
        tokens_cache_read, tokens_cache_write, cost_usd, error_message, cache_hit)
     VALUES (?, ?, ?, ?, ?, 'chat', ?, 100, ?, 0,
       CASE WHEN (? + ?) > 0 THEN (? + ?) ELSE NULL END,
       ?, ?, ?, NULL, ?)`,
  )
    .bind(
      `metric_${uniq()}`,
      ORG,
      NOW - 30,
      m.provider ?? "openai",
      m.model ?? "gpt-4o",
      m.statusCode ?? 200,
      m.tokensInput ?? null,
      m.tokensCacheRead ?? 0,
      m.tokensCacheWrite ?? 0,
      m.tokensCacheRead ?? 0,
      m.tokensCacheWrite ?? 0,
      m.tokensCacheRead ?? null,
      m.tokensCacheWrite ?? null,
      m.costUsd ?? null,
      m.cacheHit ?? 0,
    )
    .run();
}

function buildApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", (c, next) => {
    c.set("session", session);
    return next();
  });
  app.route("/api/metrics", metricsRouter);
  return app;
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0);",
  );
});

beforeEach(async () => {
  await env.DB.exec(
    `DELETE FROM request_metrics WHERE organization_id = '${ORG}';`,
  );
});

describe("cache analytics", () => {
  it("aggregates prompt-cache reads/writes and hit rates in spendForRange", async () => {
    // Hit: uncached input 700, read 2000. Miss: input 100, write 300.
    await seed({ tokensInput: 700, tokensCacheRead: 2000 });
    await seed({ tokensInput: 100, tokensCacheWrite: 300 });
    await seed({ tokensInput: 50 }); // no cache activity

    const summary = await spendForRange(env as never, ORG, {
      start: START,
      end: END,
    });
    expect(summary.requests).toBe(3);
    expect(summary.tokensCacheRead).toBe(2000);
    expect(summary.tokensCacheWrite).toBe(300);
    expect(summary.promptCacheHits).toBe(1);
    expect(summary.promptCacheHitRate).toBeCloseTo(1 / 3, 6);
    expect(summary.responseCacheHits).toBe(0);
  });

  it("counts proxy response-cache hits separately from prompt caching", async () => {
    await seed({ tokensInput: 10, cacheHit: 1 });
    const summary = await spendForRange(env as never, ORG, {
      start: START,
      end: END,
    });
    expect(summary.responseCacheHits).toBe(1);
    expect(summary.promptCacheHits).toBe(0);
  });

  it("breaks cache usage down per provider+model via cacheUsageByModel", async () => {
    await seed({
      provider: "anthropic",
      model: "claude-a",
      tokensInput: 500,
      tokensCacheRead: 1500,
    });
    await seed({
      provider: "anthropic",
      model: "claude-a",
      tokensInput: 500,
      tokensCacheRead: 2500,
    });
    await seed({
      provider: "anthropic",
      model: "claude-b",
      tokensInput: 800,
      tokensCacheWrite: 400,
    });

    const rows = await cacheUsageByModel(env as never, ORG, START, END);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-a",
      requests: 2,
      tokensInput: 1000,
      tokensCacheRead: 4000,
      tokensCacheWrite: 0,
      promptCacheHits: 2,
      promptCacheHitRate: 1,
      responseCacheHits: 0,
    });
    expect(rows[1]).toMatchObject({
      model: "claude-b",
      tokensCacheWrite: 400,
      promptCacheHits: 0,
      promptCacheHitRate: 0,
    });
  });

  it("exposes the aggregates through /api/metrics/summary and /api/metrics/cache", async () => {
    await seed({ tokensInput: 700, tokensCacheRead: 2000, costUsd: 0.5 });
    await seed({
      provider: "anthropic",
      model: "claude-a",
      tokensInput: 100,
      tokensCacheWrite: 300,
      cacheHit: 1,
    });

    const app = buildApp();
    const summaryRes = await app.request(
      `/api/metrics/summary?start=${START}&end=${END}`,
      undefined,
      env as never,
    );
    expect(summaryRes.status).toBe(200);
    const { summary } = (await summaryRes.json()) as {
      summary: Record<string, number>;
    };
    expect(summary.tokensCacheRead).toBe(2000);
    expect(summary.tokensCacheWrite).toBe(300);
    expect(summary.responseCacheHits).toBe(1);
    expect(summary.promptCacheHits).toBe(1);

    const cacheRes = await app.request(
      `/api/metrics/cache?start=${START}&end=${END}`,
      undefined,
      env as never,
    );
    expect(cacheRes.status).toBe(200);
    const cacheBody = (await cacheRes.json()) as {
      usage: Array<Record<string, unknown>>;
    };
    expect(cacheBody.usage).toHaveLength(2);
    const openaiRow = cacheBody.usage.find(
      (r) => r.model === "gpt-4o",
    ) as Record<string, unknown>;
    expect(openaiRow).toMatchObject({
      provider: "openai",
      tokensCacheRead: 2000,
      promptCacheHits: 1,
    });
  });

  it("returns new columns on /api/metrics/requests rows", async () => {
    await seed({
      tokensInput: 700,
      tokensCacheRead: 1234,
      tokensCacheWrite: 12,
    });
    const app = buildApp();
    const res = await app.request(
      `/api/metrics/requests?start=${START}&end=${END}`,
      undefined,
      env as never,
    );
    expect(res.status).toBe(200);
    const { requests } = (await res.json()) as {
      requests: Array<Record<string, unknown>>;
    };
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tokens_cache_read: 1234,
      tokens_cache_write: 12,
      tokens_cached: 1246,
    });
  });
});
