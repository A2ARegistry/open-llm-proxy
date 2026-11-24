import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { metricsRouter } from "~/src/api/metrics";
import type { AppBindings } from "~/src/app";
import {
  getRequest,
  listRequests,
  parseRequestFilters,
  requestFacets,
  type RequestDetail,
  type RequestFacet,
  type RequestLogRow,
} from "~/src/metrics/request-log";
import type { SessionAuth } from "~/src/types";

const ORG = "org_request_log";
const OTHER_ORG = "org_request_log_other";
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
  id: string;
  organizationId?: string;
  apiKeyId?: string | null;
  userId?: string | null;
  timestamp?: number;
  provider?: string;
  model?: string;
  statusCode?: number;
  cacheHit?: number;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  errorMessage?: string | null;
}

async function seed(rows: SeedRow[]) {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO request_metrics
           (id, organization_id, user_id, api_key_id, timestamp, provider, model, method,
            status_code, latency_ms, tokens_input, tokens_output, tokens_cache_read,
            tokens_cache_write, cost_usd, error_message, cache_hit)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', ?, 120, 10, 5, ?, ?, 0.001, ?, ?)`,
      ).bind(
        r.id,
        r.organizationId ?? ORG,
        r.userId ?? null,
        r.apiKeyId === undefined ? "key_a" : r.apiKeyId,
        r.timestamp ?? NOW - 30,
        r.provider ?? "local-m5",
        r.model ?? "qwen",
        r.statusCode ?? 200,
        r.tokensCacheRead ?? null,
        r.tokensCacheWrite ?? null,
        r.errorMessage ?? null,
        r.cacheHit ?? 0,
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

async function get(path: string) {
  return app().request(path, {}, env);
}

function ids(rows: RequestLogRow[]) {
  return rows.map((r) => r.id);
}

async function list(extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    start: String(START),
    end: String(END),
    ...extra,
  });
  const res = await get(`/api/metrics/requests?${query.toString()}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    requests: RequestLogRow[];
    total: number;
    limit: number;
    offset: number;
  };
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}', spend_disabled_until INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified BOOLEAN NOT NULL, image TEXT, createdAt TIMESTAMP NOT NULL, updatedAt TIMESTAMP NOT NULL, lastSignedInAt TIMESTAMP);",
  );
});

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM request_metrics; DELETE FROM api_keys WHERE id = 'key_a'; DELETE FROM users WHERE id = 'user_rl';",
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, status)
       VALUES ('key_a', ?, 'alice', 'hash_rl_a', 'olp_aaaa', 'user_1', 0, 'active')`,
    ).bind(ORG),
    env.DB.prepare(
      `INSERT INTO users (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('user_rl', 'Owner', 'owner-rl@acme.test', 1, 0, 0)`,
    ),
  ]);
});

describe("parseRequestFilters", () => {
  it("reads optional filters and drops empty values", () => {
    const q: Record<string, string> = {
      status: "error",
      cache: "none",
      apiKeyId: "key_a",
      model: "",
    };
    expect(parseRequestFilters((k) => q[k])).toEqual({
      status: "error",
      cache: "none",
      apiKeyId: "key_a",
      model: undefined,
    });
  });

  it("rejects unknown status and cache values", () => {
    expect(
      parseRequestFilters((k) => (k === "status" ? "bad" : undefined)),
    ).toMatch(/^status must be one of/);
    expect(
      parseRequestFilters((k) => (k === "cache" ? "bad" : undefined)),
    ).toMatch(/^cache must be one of/);
  });
});

describe("GET /api/metrics/requests", () => {
  it("pages newest first and returns the total", async () => {
    await seed([
      { id: "r1", timestamp: NOW - 300 },
      { id: "r2", timestamp: NOW - 200 },
      { id: "r3", timestamp: NOW - 100 },
      { id: "x", organizationId: OTHER_ORG },
      { id: "old", timestamp: START - 10 },
    ]);
    const first = await list({ limit: "2" });
    expect(ids(first.requests)).toEqual(["r3", "r2"]);
    expect(first).toMatchObject({ total: 3, limit: 2, offset: 0 });

    const second = await list({ limit: "2", offset: "2" });
    expect(ids(second.requests)).toEqual(["r1"]);
    expect(second.total).toBe(3);
  });

  it("defaults and clamps limit and offset", async () => {
    await seed([{ id: "r1" }]);
    expect(await list({ limit: "999", offset: "-5" })).toMatchObject({
      limit: 200,
      offset: 0,
    });
    expect(await list()).toMatchObject({ limit: 50, offset: 0 });
  });

  it("returns error_message on rows", async () => {
    await seed([{ id: "bad", statusCode: 502, errorMessage: "upstream down" }]);
    const { requests } = await list();
    expect(requests[0]).toMatchObject({
      status_code: 502,
      error_message: "upstream down",
    });
  });

  it("filters by provider, model and key", async () => {
    await seed([
      { id: "a", provider: "local-m5", model: "qwen", apiKeyId: "key_a" },
      { id: "b", provider: "openai", model: "gpt", apiKeyId: "key_b" },
      { id: "c", provider: "openai", model: "mini", apiKeyId: null },
    ]);
    expect(ids((await list({ provider: "openai" })).requests).sort()).toEqual([
      "b",
      "c",
    ]);
    expect(ids((await list({ model: "gpt" })).requests)).toEqual(["b"]);
    expect(ids((await list({ apiKeyId: "key_a" })).requests)).toEqual(["a"]);
    expect(ids((await list({ apiKeyId: "none" })).requests)).toEqual(["c"]);
  });

  it("filters by status class", async () => {
    await seed([
      { id: "ok", statusCode: 200 },
      { id: "c4", statusCode: 429 },
      { id: "c5", statusCode: 503 },
    ]);
    const byStatus = async (status: string) =>
      ids((await list({ status })).requests).sort();
    expect(await byStatus("success")).toEqual(["ok"]);
    expect(await byStatus("error")).toEqual(["c4", "c5"]);
    expect(await byStatus("client_error")).toEqual(["c4"]);
    expect(await byStatus("server_error")).toEqual(["c5"]);
  });

  it("filters by cache kind", async () => {
    await seed([
      { id: "resp", cacheHit: 1, tokensCacheRead: 50 },
      { id: "read", tokensCacheRead: 50, tokensCacheWrite: 10 },
      { id: "write", tokensCacheWrite: 10 },
      { id: "plain" },
    ]);
    const byCache = async (cache: string) =>
      ids((await list({ cache })).requests);
    expect(await byCache("response")).toEqual(["resp"]);
    expect(await byCache("prompt_read")).toEqual(["read"]);
    expect(await byCache("prompt_write")).toEqual(["write"]);
    expect(await byCache("none")).toEqual(["plain"]);
  });

  it("rejects bad filters and ranges", async () => {
    const bad = await get(
      `/api/metrics/requests?start=${START}&end=${END}&status=nope`,
    );
    expect(bad.status).toBe(400);
    const range = await get(`/api/metrics/requests?start=${END}&end=${START}`);
    expect(range.status).toBe(400);
  });

  it("listRequests works without optional filters", async () => {
    await seed([{ id: "r1" }]);
    const res = await listRequests(env, ORG, { start: START, end: END }, 10, 0);
    expect(res.total).toBe(1);
  });
});

describe("GET /api/metrics/requests/facets", () => {
  it("lists provider + model pairs, busiest first, for this org", async () => {
    await seed([
      { id: "a", provider: "openai", model: "gpt" },
      { id: "b", provider: "openai", model: "gpt" },
      { id: "c", provider: "local-m5", model: "qwen" },
      { id: "x", organizationId: OTHER_ORG, provider: "other", model: "m" },
    ]);
    const res = await get(
      `/api/metrics/requests/facets?start=${START}&end=${END}`,
    );
    expect(res.status).toBe(200);
    const { facets } = (await res.json()) as { facets: RequestFacet[] };
    expect(facets).toEqual([
      { provider: "openai", model: "gpt", requests: 2 },
      { provider: "local-m5", model: "qwen", requests: 1 },
    ]);
    expect(await requestFacets(env, ORG, START - 7200, START - 3600)).toEqual(
      [],
    );
  });

  it("rejects a bad range", async () => {
    const res = await get(
      `/api/metrics/requests/facets?start=${END}&end=${START}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/metrics/requests/:id", () => {
  it("returns the row with its key", async () => {
    await seed([{ id: "k1", apiKeyId: "key_a", errorMessage: "boom" }]);
    const res = await get("/api/metrics/requests/k1");
    expect(res.status).toBe(200);
    const { request } = (await res.json()) as { request: RequestDetail };
    expect(request).toMatchObject({
      id: "k1",
      error_message: "boom",
      key_name: "alice",
      key_prefix: "olp_aaaa",
      key_status: "active",
      user_name: null,
    });
  });

  it("returns the user for keyless dashboard traffic", async () => {
    await seed([{ id: "u1", apiKeyId: null, userId: "user_rl" }]);
    const request = await getRequest(env, ORG, "u1");
    expect(request).toMatchObject({
      key_name: null,
      user_name: "Owner",
      user_email: "owner-rl@acme.test",
    });
  });

  it("404s for unknown ids and other orgs' rows", async () => {
    await seed([{ id: "theirs", organizationId: OTHER_ORG }]);
    expect((await get("/api/metrics/requests/nope")).status).toBe(404);
    expect((await get("/api/metrics/requests/theirs")).status).toBe(404);
  });
});
