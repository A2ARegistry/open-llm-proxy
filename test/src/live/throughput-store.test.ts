// [fork] W12: stored 10-minute throughput rollups.
import { createBoxTables } from "./box-schema";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  rollupThroughputRecent,
  throughputRollupsStatement,
} from "~/src/live/throughput-store";

const e = { ...env, VPC_BINDINGS: "HALOGEN:org_a|org_b" } as unknown as Env;
// 10 000 s -> window [2400, 9600).
const NOW = 10_000;

async function config(org: string, provider: string, settings: object) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO provider_configs (id, organization_id, provider, config) VALUES (?, ?, ?, ?)",
  )
    .bind(
      `${org}-${provider}`,
      org,
      provider,
      JSON.stringify({ keys: [], settings }),
    )
    .run();
}

async function request(
  id: string,
  org: string,
  provider: string,
  ts: number,
  latencyMs: number,
) {
  await env.DB.prepare(
    `INSERT INTO request_metrics
       (id, organization_id, timestamp, provider, model, method, status_code,
        latency_ms, tokens_input, tokens_output, cache_hit, ttft_ms, decode_ms)
     VALUES (?, ?, ?, ?, 'm', 'chat', 200, ?, 6000, 12000, 0, NULL, NULL)`,
  )
    .bind(id, org, ts, provider, latencyMs)
    .run();
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));",
  );
  await createBoxTables(env.DB, ["throughput_rollups"]);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM request_metrics");
  await env.DB.exec("DELETE FROM provider_configs");
  await env.DB.exec("DELETE FROM throughput_rollups");
  await config("org_a", "box", { transport: "vpc", vpcBinding: "HALOGEN" });
  await config("org_b", "box", { transport: "vpc", vpcBinding: "HALOGEN" });
  await config("org_a", "openai", {});
});

function rollups(org: string) {
  return throughputRollupsStatement(e, org, 0, 20_000).all<{
    ts: number;
    decode_tps: number;
    decode_tps_max: number;
    prefill_tps: number;
    prefill_tps_max: number;
    requests: number;
  }>();
}

describe("rollupThroughputRecent", () => {
  it("writes avg and max per org, zero rows for idle buckets", async () => {
    // Non-streamed, 60 s over [3000, 3060): 12000 output, 6000 prefill.
    await request("r1", "org_a", "box", 3060, 60_000);
    await request("r2", "org_a", "openai", 3060, 60_000); // not the box
    await request("r3", "org_b", "box", 5000, 10_000);
    await rollupThroughputRecent(e, NOW);

    const a = (await rollups("org_a")).results;
    expect(a.map((r) => r.ts)).toEqual([
      2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600, 7200, 7800, 8400, 9000,
    ]);
    const busy = a.find((r) => r.ts === 3000)!;
    expect(busy.decode_tps).toBeCloseTo(12_000 / 600);
    expect(busy.decode_tps_max).toBeCloseTo(200);
    expect(busy.prefill_tps).toBeCloseTo(6000 / 600);
    expect(busy.prefill_tps_max).toBeCloseTo(100);
    expect(busy.requests).toBe(1);
    const idle = a.find((r) => r.ts === 2400)!;
    expect(idle).toMatchObject({
      decode_tps: 0,
      decode_tps_max: 0,
      requests: 0,
    });

    const b = (await rollups("org_b")).results;
    expect(b.find((r) => r.ts === 4800)!.requests).toBe(1);
  });

  it("replaces on re-run: one row per bucket", async () => {
    await request("r1", "org_a", "box", 3060, 60_000);
    await rollupThroughputRecent(e, NOW);
    await rollupThroughputRecent(e, NOW);
    expect((await rollups("org_a")).results).toHaveLength(12);
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM throughput_rollups",
    ).all<{ n: number }>();
    expect(results[0].n).toBe(24);
  });

  it("does nothing when no org uses the box", async () => {
    await env.DB.exec("DELETE FROM provider_configs");
    await rollupThroughputRecent(e, NOW);
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM throughput_rollups",
    ).all<{ n: number }>();
    expect(results[0].n).toBe(0);
  });
});
