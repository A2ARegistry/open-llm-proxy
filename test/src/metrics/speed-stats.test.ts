import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { metricsRouter } from "~/src/api/metrics";
import type { AppBindings } from "~/src/app";
import {
  decodeTokensPerSecond,
  prefillTokensPerSecond,
  speedByModel,
} from "~/src/metrics/speed-stats";
import type { SessionAuth } from "~/src/types";

const ORG = "org_speed_metrics";
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
  provider?: string;
  model?: string;
  statusCode?: number;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  ttftMs?: number | null;
  decodeMs?: number | null;
  organizationId?: string;
}

async function seed(rows: SeedRow[]) {
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO request_metrics
           (id, organization_id, timestamp, provider, model, method, status_code,
            latency_ms, tokens_input, tokens_output, ttft_ms, decode_ms, cache_hit)
         VALUES (?, ?, ?, ?, ?, 'chat', ?, 100, ?, ?, ?, ?, 0)`,
      ).bind(
        `m_${Math.random().toString(36).slice(2)}`,
        r.organizationId ?? ORG,
        NOW - 30,
        r.provider ?? "local-m5",
        r.model ?? "qwen",
        r.statusCode ?? 200,
        r.tokensInput ?? null,
        r.tokensOutput ?? null,
        r.ttftMs ?? null,
        r.decodeMs ?? null,
      ),
    ),
  );
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM request_metrics;");
});

describe("rate helpers", () => {
  it("computes decode tokens/s from tokens after the first", () => {
    expect(decodeTokensPerSecond(101, 2_000)).toBe(50);
    expect(decodeTokensPerSecond(null, 2_000)).toBeNull();
    expect(decodeTokensPerSecond(1, 2_000)).toBeNull();
    expect(decodeTokensPerSecond(10, null)).toBeNull();
    expect(decodeTokensPerSecond(10, 0)).toBeNull();
  });

  it("computes prefill tokens/s over TTFT", () => {
    expect(prefillTokensPerSecond(4_000, 500)).toBe(8_000);
    expect(prefillTokensPerSecond(null, 500)).toBeNull();
    expect(prefillTokensPerSecond(0, 500)).toBeNull();
    expect(prefillTokensPerSecond(100, 0)).toBeNull();
  });
});

describe("speedByModel", () => {
  it("groups successful streams by provider and model", async () => {
    await seed([
      { tokensInput: 1_000, tokensOutput: 101, ttftMs: 200, decodeMs: 2_000 },
      { tokensInput: 2_000, tokensOutput: 201, ttftMs: 400, decodeMs: 2_000 },
      { tokensInput: 3_000, tokensOutput: 301, ttftMs: 600, decodeMs: 3_000 },
      // Cancelled stream: TTFT counts, decode does not.
      { tokensInput: 500, tokensOutput: null, ttftMs: 800, decodeMs: null },
      // Excluded: failed, non-streamed, other org.
      { statusCode: 500, ttftMs: 5, decodeMs: 5, tokensOutput: 9 },
      { tokensInput: 10, tokensOutput: 10, ttftMs: null },
      { organizationId: "other_org", ttftMs: 1, decodeMs: 1, tokensOutput: 9 },
      {
        provider: "openai",
        model: "gpt-4o",
        tokensInput: 0,
        tokensOutput: 1,
        ttftMs: 300,
        decodeMs: 0,
      },
    ]);

    const stats = await speedByModel(env, ORG, START, END);
    expect(stats).toEqual([
      {
        provider: "local-m5",
        model: "qwen",
        requests: 4,
        ttftP50: 400,
        ttftP95: 800,
        decodeTpsP50: 100,
        decodeTpsP95: 100,
        prefillTpsP50: 5_000,
      },
      {
        provider: "openai",
        model: "gpt-4o",
        requests: 1,
        ttftP50: 300,
        ttftP95: 300,
        decodeTpsP50: null,
        decodeTpsP95: null,
        prefillTpsP50: null,
      },
    ]);
  });

  it("returns an empty list without streamed traffic", async () => {
    expect(await speedByModel(env, ORG, START, END)).toEqual([]);
  });
});

describe("GET /api/metrics/speed", () => {
  function app() {
    const a = new Hono<AppBindings>();
    a.use("*", async (c, next) => {
      c.set("session", session);
      await next();
    });
    a.route("/api/metrics", metricsRouter);
    return a;
  }

  it("returns speed stats for the session's organization", async () => {
    await seed([
      { tokensInput: 100, tokensOutput: 11, ttftMs: 50, decodeMs: 100 },
    ]);
    const res = await app().request(
      `/api/metrics/speed?start=${START}&end=${END}`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { speed: Array<{ requests: number }> };
    expect(body.speed).toHaveLength(1);
    expect(body.speed[0].requests).toBe(1);
  });

  it("rejects an inverted range", async () => {
    const res = await app().request(
      `/api/metrics/speed?start=${END}&end=${START}`,
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  it("includes timing columns in recent requests", async () => {
    await seed([{ tokensOutput: 11, ttftMs: 50, decodeMs: 100 }]);
    const res = await app().request(
      `/api/metrics/requests?start=${START}&end=${END}`,
      {},
      env,
    );
    const body = (await res.json()) as {
      requests: Array<{ ttft_ms: number; decode_ms: number }>;
    };
    expect(body.requests[0]).toMatchObject({ ttft_ms: 50, decode_ms: 100 });
  });
});
