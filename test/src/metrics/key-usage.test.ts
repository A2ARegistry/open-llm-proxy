import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { metricsRouter } from "~/src/api/metrics";
import type { AppBindings } from "~/src/app";
import { usageByKey } from "~/src/metrics/key-usage";
import type { SessionAuth } from "~/src/types";

const ORG = "org_key_usage";
const NOW = Math.floor(Date.now() / 1000);
const START = NOW - 3600;
const END = NOW + 60;

const session: SessionAuth = {
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: ORG,
  role: "owner",
  email: "owner@acme.test",
  expiresAt: 9999999999,
};

interface SeedRow {
  apiKeyId?: string | null;
  statusCode?: number;
  latencyMs?: number;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensCacheRead?: number | null;
  costUsd?: number | null;
  timestamp?: number;
  organizationId?: string;
}

async function seedKeys() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, status)
       VALUES ('key_a', ?, 'alice', 'hash_a', 'olp_aaaa', 'user_1', 0, 'active'),
              ('key_b', ?, 'bob', 'hash_b', 'olp_bbbb', 'user_1', 0, 'revoked')`,
    ).bind(ORG, ORG),
  ]);
}

async function seed(rows: SeedRow[]) {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO request_metrics
           (id, organization_id, api_key_id, timestamp, provider, model, method, status_code,
            latency_ms, tokens_input, tokens_output, tokens_cache_read, cost_usd, cache_hit)
         VALUES (?, ?, ?, ?, 'local-m5', 'qwen', 'chat', ?, ?, ?, ?, ?, ?, 0)`,
      ).bind(
        `m_${Math.random().toString(36).slice(2)}`,
        r.organizationId ?? ORG,
        r.apiKeyId === undefined ? "key_a" : r.apiKeyId,
        r.timestamp ?? NOW - 30,
        r.statusCode ?? 200,
        r.latencyMs ?? 100,
        r.tokensInput ?? null,
        r.tokensOutput ?? null,
        r.tokensCacheRead ?? null,
        r.costUsd ?? null,
      ),
    ),
  );
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}', spend_disabled_until INTEGER);",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM request_metrics; DELETE FROM api_keys;");
  await seedKeys();
});

describe("usageByKey", () => {
  it("totals requests, tokens, cost, errors and latency per key", async () => {
    await seed([
      {
        tokensInput: 1_000,
        tokensOutput: 100,
        tokensCacheRead: 50,
        costUsd: 0.5,
        latencyMs: 100,
        timestamp: NOW - 100,
      },
      {
        tokensInput: 2_000,
        tokensOutput: 200,
        costUsd: 0.25,
        latencyMs: 300,
        timestamp: NOW - 10,
      },
      { statusCode: 429, latencyMs: 5, timestamp: NOW - 50 },
      { apiKeyId: "key_b", tokensInput: 10, tokensOutput: 1 },
      // Dashboard/session traffic has no key.
      { apiKeyId: null, tokensInput: 7, tokensOutput: 3 },
      // Excluded: other org, outside the window.
      { organizationId: "other_org", tokensInput: 999 },
      { timestamp: START - 1, tokensInput: 999 },
    ]);

    const usage = await usageByKey(env, ORG, START, END);
    expect(usage).toEqual([
      {
        apiKeyId: "key_a",
        name: "alice",
        keyPrefix: "olp_aaaa",
        status: "active",
        requests: 3,
        errors: 1,
        tokensInput: 3_000,
        tokensOutput: 300,
        tokensCacheRead: 50,
        costUsd: 0.75,
        latencyAvgMs: 135,
        lastRequestAt: NOW - 10,
      },
      {
        apiKeyId: "key_b",
        name: "bob",
        keyPrefix: "olp_bbbb",
        status: "revoked",
        requests: 1,
        errors: 0,
        tokensInput: 10,
        tokensOutput: 1,
        tokensCacheRead: 0,
        costUsd: 0,
        latencyAvgMs: 100,
        lastRequestAt: NOW - 30,
      },
      {
        apiKeyId: null,
        name: null,
        keyPrefix: null,
        status: null,
        requests: 1,
        errors: 0,
        tokensInput: 7,
        tokensOutput: 3,
        tokensCacheRead: 0,
        costUsd: 0,
        latencyAvgMs: 100,
        lastRequestAt: NOW - 30,
      },
    ]);
  });

  it("keeps rows for keys that were deleted", async () => {
    await seed([{ apiKeyId: "key_gone", tokensInput: 5 }]);
    const usage = await usageByKey(env, ORG, START, END);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      apiKeyId: "key_gone",
      name: null,
      keyPrefix: null,
      status: null,
      tokensInput: 5,
    });
  });

  it("returns an empty list without traffic", async () => {
    expect(await usageByKey(env, ORG, START, END)).toEqual([]);
  });
});

describe("GET /api/metrics/keys", () => {
  function app() {
    const a = new Hono<AppBindings>();
    a.use("*", async (c, next) => {
      c.set("session", session);
      await next();
    });
    a.route("/api/metrics", metricsRouter);
    return a;
  }

  it("returns per-key usage for the session's organization", async () => {
    await seed([{ tokensInput: 100, tokensOutput: 11 }]);
    const res = await app().request(
      `/api/metrics/keys?start=${START}&end=${END}`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      keys: Array<{ apiKeyId: string; requests: number }>;
    };
    expect(body.keys).toEqual([
      expect.objectContaining({ apiKeyId: "key_a", requests: 1 }),
    ]);
  });

  it("rejects an inverted range", async () => {
    const res = await app().request(
      `/api/metrics/keys?start=${END}&end=${START}`,
      {},
      env,
    );
    expect(res.status).toBe(400);
  });
});
