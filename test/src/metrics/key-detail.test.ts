import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { metricsRouter } from "~/src/api/metrics";
import type { AppBindings } from "~/src/app";
import {
  bucketSecondsFor,
  keyDetailUsage,
  type KeyDetailUsage,
} from "~/src/metrics/key-detail";
import type { SessionAuth } from "~/src/types";

const ORG = "org_key_detail";
const OTHER_ORG = "org_key_detail_other";
const DAY = 86400;
// Midday UTC, so hour and day buckets are easy to predict.
const BASE = Math.floor(Date.now() / 1000 / DAY) * DAY - DAY + 12 * 3600;

const session: SessionAuth = {
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: ORG,
  role: "owner",
  email: "owner@acme.test",
  expiresAt: 9999999999,
};

interface SeedRow {
  timestamp: number;
  apiKeyId?: string | null;
  organizationId?: string;
  provider?: string;
  model?: string;
  statusCode?: number;
  costUsd?: number | null;
  tokensInput?: number | null;
}

async function seed(rows: SeedRow[]) {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO request_metrics
           (id, organization_id, api_key_id, timestamp, provider, model, method,
            status_code, latency_ms, tokens_input, tokens_output, tokens_cache_read,
            cost_usd, cache_hit)
         VALUES (?, ?, ?, ?, ?, ?, 'chat', ?, 100, ?, 5, 2, ?, 0)`,
      ).bind(
        `m_${Math.random().toString(36).slice(2)}`,
        r.organizationId ?? ORG,
        r.apiKeyId === undefined ? "key_a" : r.apiKeyId,
        r.timestamp,
        r.provider ?? "local-m5",
        r.model ?? "qwen",
        r.statusCode ?? 200,
        r.tokensInput ?? 10,
        r.costUsd === undefined ? 0.01 : r.costUsd,
      ),
    ),
  );
}

function app() {
  const a = new Hono<AppBindings>();
  a.use("*", async (c, next) => {
    c.set("session", session);
    await next();
  });
  a.route("/api/metrics", metricsRouter);
  return a;
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM request_metrics;");
});

describe("bucketSecondsFor", () => {
  it("uses hours up to 48h, days beyond", () => {
    expect(bucketSecondsFor(0, 48 * 3600)).toBe(3600);
    expect(bucketSecondsFor(0, 48 * 3600 + 1)).toBe(DAY);
  });
});

describe("keyDetailUsage", () => {
  it("totals, buckets and splits one key's traffic", async () => {
    await seed([
      { timestamp: BASE + 60, statusCode: 500, costUsd: 0.02 },
      { timestamp: BASE + 120 },
      { timestamp: BASE + 3600 + 5, provider: "openai", model: "gpt" },
      // Outside the window but counts toward lifetime spend.
      { timestamp: BASE - 10 * DAY, costUsd: 1 },
      // Other keys and orgs never count.
      { timestamp: BASE + 60, apiKeyId: "key_b", costUsd: 5 },
      { timestamp: BASE + 60, apiKeyId: null, costUsd: 5 },
      { timestamp: BASE + 60, organizationId: OTHER_ORG, costUsd: 5 },
    ]);

    const usage = await keyDetailUsage(env, ORG, "key_a", BASE, BASE + DAY);

    expect(usage.bucketSeconds).toBe(3600);
    expect(usage.summary).toMatchObject({
      requests: 3,
      errors: 1,
      tokensInput: 30,
      tokensOutput: 15,
      tokensCacheRead: 6,
      latencyAvgMs: 100,
      lastRequestAt: BASE + 3605,
    });
    expect(usage.summary.costUsd).toBeCloseTo(0.04);
    expect(usage.series).toEqual([
      { t: BASE, requests: 2, errors: 1, costUsd: expect.closeTo(0.03) },
      { t: BASE + 3600, requests: 1, errors: 0, costUsd: 0.01 },
    ]);
    expect(usage.models).toEqual([
      {
        provider: "local-m5",
        model: "qwen",
        requests: 2,
        errors: 1,
        costUsd: expect.closeTo(0.03),
      },
      {
        provider: "openai",
        model: "gpt",
        requests: 1,
        errors: 0,
        costUsd: 0.01,
      },
    ]);
    expect(usage.lifetimeCostUsd).toBeCloseTo(1.04);
  });

  it("buckets long windows by day", async () => {
    await seed([{ timestamp: BASE }, { timestamp: BASE - DAY }]);
    const usage = await keyDetailUsage(
      env,
      ORG,
      "key_a",
      BASE - 7 * DAY,
      BASE + DAY,
    );
    expect(usage.bucketSeconds).toBe(DAY);
    expect(usage.series.map((p) => p.t)).toEqual([
      BASE - 12 * 3600 - DAY,
      BASE - 12 * 3600,
    ]);
  });

  it("returns zeros for a key without traffic", async () => {
    const usage = await keyDetailUsage(env, ORG, "key_a", BASE, BASE + DAY);
    expect(usage.summary).toEqual({
      requests: 0,
      errors: 0,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      costUsd: 0,
      latencyAvgMs: null,
      lastRequestAt: null,
    });
    expect(usage.series).toEqual([]);
    expect(usage.models).toEqual([]);
    expect(usage.lifetimeCostUsd).toBe(0);
  });
});

describe("GET /api/metrics/keys/:id", () => {
  it("returns the key's usage for the window", async () => {
    await seed([{ timestamp: BASE + 60 }]);
    const res = await app().request(
      `/api/metrics/keys/key_a?start=${BASE}&end=${BASE + DAY}`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as KeyDetailUsage;
    expect(body.summary.requests).toBe(1);
  });

  it("rejects a bad range", async () => {
    const res = await app().request(
      `/api/metrics/keys/key_a?start=${BASE + DAY}&end=${BASE}`,
      {},
      env,
    );
    expect(res.status).toBe(400);
  });
});
