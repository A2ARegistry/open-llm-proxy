import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { BufferedMetric } from "~/src/durable/metrics-buffer";

const ORG = "org_buffer_test";

function uniq(): string {
  return Math.random().toString(36).slice(2, 10);
}

function metric(overrides: Partial<BufferedMetric> = {}): BufferedMetric {
  return {
    organization_id: ORG,
    api_key_id: `key_${uniq()}`,
    timestamp: Math.floor(Date.now() / 1000),
    provider: "anthropic",
    model: "claude-sonnet-4",
    method: "chat",
    status_code: 200,
    latency_ms: 1234,
    tokens_input: 900,
    tokens_output: 100,
    tokens_cached: 3000,
    tokens_cache_read: 2500,
    tokens_cache_write: 500,
    cost_usd: 0.02,
    error_message: null,
    cache_hit: 0,
    ttft_ms: 150,
    decode_ms: 1_850,
    ...overrides,
  };
}

async function stub() {
  const id = env.METRICS_BUFFER.idFromName(uniq());
  return env.METRICS_BUFFER.get(id);
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
});

beforeEach(async () => {
  await env.DB.exec(
    `DELETE FROM request_metrics WHERE organization_id = '${ORG}';`,
  );
});

describe("MetricsBuffer DO", () => {
  it("buffers rows and flushes distinct cache token columns to D1", async () => {
    const s = await stub();
    const pushRes = await s.fetch("http://internal/push", {
      method: "POST",
      body: JSON.stringify({ entries: [metric()] }),
    });
    expect(pushRes.ok).toBe(true);
    await s.fetch("http://internal/flush");

    const { results } = await env.DB.prepare(
      `SELECT * FROM request_metrics WHERE organization_id = ?`,
    )
      .bind(ORG)
      .all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4",
      tokens_cached: 3000,
      tokens_cache_read: 2500,
      tokens_cache_write: 500,
      cache_hit: 0,
      user_id: null,
      ttft_ms: 150,
      decode_ms: 1_850,
    });
  });

  it("accepts rows with no cache activity (NULL cache columns)", async () => {
    const s = await stub();
    await s.fetch("http://internal/push", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          metric({
            tokens_input: 10,
            tokens_output: 5,
            tokens_cached: null,
            tokens_cache_read: null,
            tokens_cache_write: null,
          }),
        ],
      }),
    });
    await s.fetch("http://internal/flush");

    const { results } = await env.DB.prepare(
      `SELECT * FROM request_metrics WHERE organization_id = ?`,
    )
      .bind(ORG)
      .all<Record<string, unknown>>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      tokens_cached: null,
      tokens_cache_read: null,
      tokens_cache_write: null,
    });
  });

  it("adds timing columns to shards created before they existed", async () => {
    const s = await stub();
    await runInDurableObject(s, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TABLE metrics_buffer (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0)",
      );
    });
    await s.fetch("http://internal/push", {
      method: "POST",
      body: JSON.stringify({ entries: [metric({ ttft_ms: 42 })] }),
    });
    await s.fetch("http://internal/flush");
    const row = await env.DB.prepare(
      `SELECT ttft_ms, decode_ms, tokens_cache_read FROM request_metrics WHERE organization_id = ?`,
    )
      .bind(ORG)
      .first();
    expect(row).toMatchObject({
      ttft_ms: 42,
      decode_ms: 1_850,
      tokens_cache_read: 2500,
    });
  });

  it("stores NULL timings for rows pushed without them", async () => {
    const s = await stub();
    const legacy = metric() as Partial<BufferedMetric>;
    delete legacy.ttft_ms;
    delete legacy.decode_ms;
    await s.fetch("http://internal/push", {
      method: "POST",
      body: JSON.stringify({ entries: [legacy] }),
    });
    await s.fetch("http://internal/flush");
    const row = await env.DB.prepare(
      `SELECT ttft_ms, decode_ms FROM request_metrics WHERE organization_id = ?`,
    )
      .bind(ORG)
      .first();
    expect(row).toMatchObject({ ttft_ms: null, decode_ms: null });
  });

  it("reports buffer size via /size", async () => {
    const s = await stub();
    await s.fetch("http://internal/push", {
      method: "POST",
      body: JSON.stringify({ entries: [metric()] }),
    });
    const sizeRes = await s.fetch("http://internal/size");
    const body = (await sizeRes.json()) as { size: number };
    expect(body.size).toBeGreaterThanOrEqual(1);
    await s.fetch("http://internal/flush");
  });

  it("returns unflushed throughput rows for the org's providers, then none after a flush", async () => {
    const s = await stub();
    const now = Math.floor(Date.now() / 1000);
    await s.fetch("http://internal/push", {
      method: "POST",
      body: JSON.stringify({
        entries: [
          metric({
            provider: "box",
            timestamp: now,
            latency_ms: 2000,
            tokens_input: 1000,
            tokens_cache_read: 600,
          }),
          metric({ provider: "box", timestamp: now, status_code: 500 }),
          metric({ provider: "other", timestamp: now }),
          metric({ provider: "box", timestamp: now, organization_id: "org_x" }),
        ],
      }),
    });
    const pending = await s.throughputRows(ORG, ["box"], now - 60, now + 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      timestamp: now,
      latency_ms: 2000,
      ttft_ms: 150,
      decode_ms: 1_850,
      prefill_tokens: 400,
      tokens_output: 100,
    });
    expect(typeof pending[0].id).toBe("string");

    await s.fetch("http://internal/flush");
    expect(await s.throughputRows(ORG, ["box"], now - 60, now + 10)).toEqual(
      [],
    );
  });

  it("returns no throughput rows when no provider is given", async () => {
    const s = await stub();
    expect(await s.throughputRows(ORG, [], 0, 10)).toEqual([]);
  });
});
