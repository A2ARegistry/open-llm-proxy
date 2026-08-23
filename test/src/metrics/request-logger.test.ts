import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { recordChatRequest } from "~/src/metrics/request-logger";

// Direct-D1 path only: the MetricsBuffer DO round-trip is covered in
// durable/metrics-buffer.test.ts.
const envNoBuffer = { ...env, METRICS_BUFFER: undefined } as never;

const ORG = "org_req_logger";
const NOW = Math.floor(Date.now() / 1000);

function uniq(): string {
  return Math.random().toString(36).slice(2, 10);
}

function attempt(model = "gpt-4o") {
  return {
    organizationId: ORG,
    apiKeyId: `key_${uniq()}`,
    startedAt: Date.now() - 250,
    provider: "openai",
    model,
    method: "chat" as const,
  };
}

async function lastRow() {
  const { results } = await env.DB.prepare(
    `SELECT * FROM request_metrics WHERE organization_id = ?
     ORDER BY timestamp DESC LIMIT 1`,
  )
    .bind(ORG)
    .all<Record<string, unknown>>();
  return results[0];
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS model_pricing (provider TEXT NOT NULL, model TEXT NOT NULL, input_per_1m REAL NOT NULL DEFAULT 0, output_per_1m REAL NOT NULL DEFAULT 0, cache_read_per_1m REAL NOT NULL DEFAULT 0, cache_write_per_1m REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, model));",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM request_metrics;");
  await env.DB.exec("DELETE FROM model_pricing;");
});

describe("recordChatRequest", () => {
  it("stores prompt-cache reads and writes as distinct columns plus their sum", async () => {
    await recordChatRequest(envNoBuffer, attempt(), {
      statusCode: 200,
      usage: { input: 700, output: 100, cacheRead: 2000, cacheWrite: 300 },
      costUsd: 0.01,
    });
    const row = await lastRow();
    expect(row).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      status_code: 200,
      tokens_input: 700,
      tokens_output: 100,
      tokens_cached: 2300,
      tokens_cache_read: 2000,
      tokens_cache_write: 300,
      cost_usd: 0.01,
      cache_hit: 0,
    });
  });

  it("leaves cache columns NULL when the provider reports no cache activity", async () => {
    await recordChatRequest(envNoBuffer, attempt(), {
      statusCode: 200,
      usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
      costUsd: null,
    });
    const row = await lastRow();
    expect(row).toMatchObject({
      tokens_cached: null,
      tokens_cache_read: null,
      tokens_cache_write: null,
    });
  });

  it("estimates cost from model_pricing including cache read/write rates", async () => {
    await env.DB.prepare(
      `INSERT INTO model_pricing (provider, model, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m)
       VALUES ('openai', 'gpt-4o', 1, 2, 0.5, 1.25)`,
    ).run();
    // (1M*1 + 500K*2 + 100K*0.5 + 50K*1.25) / 1e6 = 2.1125
    await recordChatRequest(envNoBuffer, attempt(), {
      statusCode: 200,
      usage: {
        input: 1_000_000,
        output: 500_000,
        cacheRead: 100_000,
        cacheWrite: 50_000,
      },
      costUsd: null,
    });
    const row = await lastRow();
    expect(row.cost_usd).toBeCloseTo(2.1125, 6);
  });

  it("records errors without usage", async () => {
    await recordChatRequest(envNoBuffer, attempt(), {
      statusCode: 500,
      errorMessage: "upstream boom",
    });
    const row = await lastRow();
    expect(row).toMatchObject({
      status_code: 500,
      error_message: "upstream boom",
      tokens_input: null,
      tokens_output: null,
      tokens_cache_read: null,
    });
    expect(Number(row.latency_ms)).toBeGreaterThanOrEqual(0);
    expect(row.timestamp).toBeGreaterThan(NOW - 60);
  });
});
