// [fork] W12: request throughput from the request log.
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countRequests,
  mergeThroughputRows,
  rollupThroughput,
  spreadThroughput,
  MAX_REQUEST_S,
  throughputRowsStatement,
  type ThroughputRequest,
} from "~/src/live/throughput";

function req(over: Partial<ThroughputRequest> = {}): ThroughputRequest {
  return {
    timestamp: 116,
    latency_ms: 12_000,
    ttft_ms: 2000,
    decode_ms: 10_000,
    prefill_tokens: 1000,
    tokens_output: 1000,
    ...over,
  };
}

describe("spreadThroughput", () => {
  it("splits prefill and decode of a streamed request", () => {
    const pts = spreadThroughput([req()], 100, 130, 10);
    expect(pts.map((p) => p.ts)).toEqual([100, 110, 120]);
    expect(pts[0].prefillTps).toBeCloseTo(100);
    expect(pts[0].decodeTps).toBeCloseTo(40);
    expect(pts[1].prefillTps).toBe(0);
    expect(pts[1].decodeTps).toBeCloseTo(60);
    expect(pts[2]).toEqual({ ts: 120, decodeTps: 0, prefillTps: 0 });
    expect(pts.reduce((s, p) => s + p.decodeTps * 10, 0)).toBeCloseTo(1000);
  });

  it("spreads a long prefill across buckets", () => {
    const pts = spreadThroughput(
      [
        req({
          timestamp: 720,
          latency_ms: 720_000,
          ttft_ms: 720_000,
          decode_ms: 0,
          prefill_tokens: 700_000,
          tokens_output: 0,
        }),
      ],
      0,
      720,
      10,
    );
    expect(pts).toHaveLength(72);
    expect(pts[0].prefillTps).toBeCloseTo(972.22, 1);
    expect(Math.max(...pts.map((p) => p.prefillTps))).toBeCloseTo(972.22, 1);
  });

  it("spreads a non-streamed request over its whole latency", () => {
    const pts = spreadThroughput(
      [
        req({
          timestamp: 20,
          latency_ms: 20_000,
          ttft_ms: null,
          decode_ms: null,
        }),
      ],
      0,
      30,
      10,
    );
    expect(pts[0].decodeTps).toBeCloseTo(50);
    expect(pts[1].decodeTps).toBeCloseTo(50);
    expect(pts[0].prefillTps).toBeCloseTo(50);
    expect(pts[2].decodeTps).toBe(0);
  });

  it("puts tokens of a zero-length phase into the bucket of its start", () => {
    const pts = spreadThroughput(
      [
        req({
          timestamp: 10,
          latency_ms: 10_000,
          ttft_ms: 0,
          decode_ms: 10_000,
        }),
      ],
      0,
      20,
      10,
    );
    expect(pts[0].prefillTps).toBeCloseTo(100);
    expect(pts[0].decodeTps).toBeCloseTo(100);
  });

  it("ignores token-less phases and out-of-range requests", () => {
    const pts = spreadThroughput(
      [
        req({ prefill_tokens: 0, tokens_output: 0 }),
        req({ timestamp: 1000 }),
        req({ timestamp: 10, latency_ms: 0, ttft_ms: 0, decode_ms: 0 }),
        req({ timestamp: 500, latency_ms: 0, ttft_ms: 0, decode_ms: 0 }),
      ],
      0,
      20,
      10,
    );
    // Only the instant request at t=10 contributes (to bucket 10).
    expect(pts[0]).toEqual({ ts: 0, decodeTps: 0, prefillTps: 0 });
    expect(pts[1].decodeTps).toBeCloseTo(100);
  });

  it("returns zeros for idle buckets", () => {
    const pts = spreadThroughput([], 100, 160, 10);
    expect(pts).toHaveLength(6);
    expect(pts.every((p) => p.decodeTps === 0 && p.prefillTps === 0)).toBe(
      true,
    );
  });
});

describe("countRequests", () => {
  it("counts requests overlapping each bucket", () => {
    const counts = countRequests(
      [
        req({ timestamp: 116, latency_ms: 12_000 }), // [104, 116)
        req({ timestamp: 125, latency_ms: 0 }), // instant at 125
        req({ timestamp: 5000, latency_ms: 0 }), // out of range
        req({ timestamp: 50, latency_ms: 0 }), // before range
      ],
      100,
      130,
      10,
    );
    expect(counts).toEqual([1, 1, 1]);
  });
});

describe("rollupThroughput", () => {
  it("averages and maxes sixty 10 s points", () => {
    const pts = Array.from({ length: 60 }, (_, i) => ({
      ts: 600 + i * 10,
      decodeTps: i === 7 ? 120 : 0,
      prefillTps: i === 3 ? 60 : 0,
    }));
    expect(rollupThroughput(pts)).toEqual([
      {
        ts: 600,
        decode_tps: 2,
        decode_tps_max: 120,
        prefill_tps: 1,
        prefill_tps_max: 60,
      },
    ]);
  });

  it("emits one row per 10-minute bucket", () => {
    const pts = [
      { ts: 0, decodeTps: 1, prefillTps: 0 },
      { ts: 600, decodeTps: 3, prefillTps: 0 },
    ];
    expect(rollupThroughput(pts).map((r) => r.ts)).toEqual([0, 600]);
  });
});

describe("throughputRowsStatement", () => {
  beforeAll(async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
    );
  });

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM request_metrics");
  });

  async function insert(
    id: string,
    o: {
      org?: string;
      provider?: string;
      ts?: number;
      latency?: number;
      status?: number;
      cacheHit?: number;
      input?: number | null;
      cacheRead?: number | null;
      cached?: number | null;
      output?: number | null;
    } = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO request_metrics
         (id, organization_id, timestamp, provider, model, method, status_code,
          latency_ms, tokens_input, tokens_output, tokens_cached, tokens_cache_read,
          cache_hit, ttft_ms, decode_ms)
       VALUES (?, ?, ?, ?, 'm', 'chat', ?, ?, ?, ?, ?, ?, ?, 100, 900)`,
    )
      .bind(
        id,
        o.org ?? "org_a",
        o.ts ?? 1000,
        o.provider ?? "box",
        o.status ?? 200,
        o.latency ?? 1000,
        o.input === undefined ? 500 : o.input,
        o.output === undefined ? 50 : o.output,
        o.cached ?? null,
        o.cacheRead ?? null,
        o.cacheHit ?? 0,
      )
      .run();
  }

  it("filters errors, cache hits, other providers, orgs and ranges", async () => {
    await insert("ok");
    await insert("err", { status: 500 });
    await insert("hit", { cacheHit: 1 });
    await insert("prov", { provider: "other" });
    await insert("org", { org: "org_b" });
    await insert("before", { ts: 900 });
    await insert("after", { ts: 5000, latency: 1000 });
    const { results } = await throughputRowsStatement(
      env as unknown as Env,
      "org_a",
      ["box"],
      1000,
      2000,
    ).all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      timestamp: 1000,
      latency_ms: 1000,
      ttft_ms: 100,
      decode_ms: 900,
      prefill_tokens: 500,
      tokens_output: 50,
    });
  });

  it("stops at to + MAX_REQUEST_S instead of scanning to the present", async () => {
    // Both started inside [1000, 2000); only the first ends before the bound.
    await insert("long", {
      ts: 2000 + MAX_REQUEST_S - 1,
      latency: (MAX_REQUEST_S + 500) * 1000,
    });
    await insert("too-long", {
      ts: 2000 + MAX_REQUEST_S,
      latency: (MAX_REQUEST_S + 500) * 1000,
    });
    const { results } = await throughputRowsStatement(
      env as unknown as Env,
      "org_a",
      ["box"],
      1000,
      2000,
    ).all<{ timestamp: number }>();
    expect(results.map((r) => r.timestamp)).toEqual([2000 + MAX_REQUEST_S - 1]);
  });

  it("keeps a request that started before the range and ends in it", async () => {
    await insert("straddle", { ts: 1000, latency: 5000 });
    const { results } = await throughputRowsStatement(
      env as unknown as Env,
      "org_a",
      ["box"],
      1000,
      2000,
    ).all();
    expect(results).toHaveLength(1);
  });

  it("subtracts cache reads, falling back to tokens_cached, never below 0", async () => {
    await insert("read", { ts: 1001, input: 500, cacheRead: 200, cached: 50 });
    await insert("cached", { ts: 1002, input: 500, cached: 50 });
    await insert("over", { ts: 1003, input: 10, cacheRead: 50 });
    await insert("null", { ts: 1004, input: null, output: null });
    const { results } = await throughputRowsStatement(
      env as unknown as Env,
      "org_a",
      ["box"],
      1000,
      2000,
    ).all<{
      timestamp: number;
      prefill_tokens: number;
      tokens_output: number;
    }>();
    expect(results.map((r) => r.prefill_tokens)).toEqual([300, 450, 0, 0]);
    expect(results[3].tokens_output).toBe(0);
  });
});

describe("mergeThroughputRows", () => {
  it("adds pending rows and drops ones already read from D1", () => {
    const merged = mergeThroughputRows(
      [req({ id: "a", timestamp: 1 }), req({ id: "b", timestamp: 2 })],
      [req({ id: "b", timestamp: 2 }), req({ id: "c", timestamp: 3 })],
    );
    expect(merged.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
