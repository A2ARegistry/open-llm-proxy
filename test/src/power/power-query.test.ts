// [fork] W13: batched energy and token reads for the Power page.
import migration from "../../../migrations/0006_box_samples.sql?raw";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPowerData } from "~/src/power/power-query";

const ORG = "org_power";
const OTHER = "org_other";
const NOW = 1_800_000_000;
const DAY = 86400;
const e = {
  ...env,
  VPC_BINDINGS: `HALOGEN:${ORG}`,
  HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}`,
  HALOGEN: { fetch: () => new Response("") },
  BOXSTATS: { fetch: () => new Response("") },
} as unknown as Env;

async function host(
  res: 10 | 600,
  ts: number,
  w: number | null,
  over: {
    samples?: number;
    ok?: number;
    max?: number | null;
    binding?: string;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO host_samples (binding, resolution_s, ts, ok, samples, gpu_power_w, gpu_power_w_max)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      over.binding ?? "BOXSTATS",
      res,
      ts,
      over.ok ?? 1,
      res === 600 ? (over.samples ?? 60) : null,
      w,
      over.max ?? null,
    )
    .run();
}

async function price(
  provider: string,
  model: string,
  rates: [number, number, number, number],
) {
  await env.DB.prepare(
    `INSERT INTO model_pricing
       (provider, model, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(provider, model, ...rates)
    .run();
}

async function provider(org: string, name: string, settings: object) {
  await env.DB.prepare(
    "INSERT INTO provider_configs (id, organization_id, provider, config) VALUES (?, ?, ?, ?)",
  )
    .bind(`${org}-${name}`, org, name, JSON.stringify({ keys: [], settings }))
    .run();
}

let n = 0;
async function request(
  ts: number,
  over: {
    org?: string;
    provider?: string;
    status?: number;
    cacheHit?: number;
  } = {},
) {
  await env.DB.prepare(
    `INSERT INTO request_metrics
       (id, organization_id, timestamp, provider, model, method, status_code, latency_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cache_hit)
     VALUES (?, ?, ?, ?, 'm', 'chat', ?, 100, 1000, 200, 300, NULL, ?)`,
  )
    .bind(
      `r${n++}`,
      over.org ?? ORG,
      ts,
      over.provider ?? "local-m5",
      over.status ?? 200,
      over.cacheHit ?? 0,
    )
    .run();
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0, ttft_ms INTEGER, decode_ms INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS tenant_settings (organization_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (organization_id, key));",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS model_pricing (provider TEXT NOT NULL, model TEXT NOT NULL, input_per_1m REAL NOT NULL DEFAULT 0, output_per_1m REAL NOT NULL DEFAULT 0, cache_read_per_1m REAL NOT NULL DEFAULT 0, cache_write_per_1m REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, model));",
  );
  await env.DB.exec("DROP TABLE IF EXISTS host_samples");
  const create = migration
    .split(";")
    .map((s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim())
    .find((s) => s.startsWith("CREATE TABLE host_samples "))!;
  await env.DB.exec(create);
});

beforeEach(async () => {
  for (const t of [
    "host_samples",
    "request_metrics",
    "provider_configs",
    "tenant_settings",
    "model_pricing",
  ]) {
    await env.DB.exec(`DELETE FROM ${t}`);
  }
  await provider(ORG, "local-m5", { transport: "vpc", vpcBinding: "HALOGEN" });
  await provider(ORG, "openai", {});
});

const T0 = NOW - DAY; // bucket-aligned: NOW is a multiple of 600
const range = [{ start: T0, end: NOW }];

describe("loadPowerData energy", () => {
  it("unaligned range start counts the edge rollup pro rata", async () => {
    await host(600, T0, 20);
    await host(600, T0 + 600, 20);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [{ start: T0 + 300, end: T0 + 1200 }],
      NOW,
    );
    expect(periods[0].measuredS).toBeCloseTo(900);
    expect(periods[0].measuredWs).toBeCloseTo(20 * 900);
  });

  it("unaligned range end never counts more than the range", async () => {
    await host(600, T0, 20);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [
        { start: T0, end: T0 + 450 },
        { start: T0 + 450, end: T0 + 600 },
      ],
      NOW,
    );
    expect(periods.map((p) => p.measuredS)).toEqual([450, 150]);
  });

  it("raw rows older than the raw retention are not read", async () => {
    // a bucket with no rollup 40 days ago: its raw rows would be pruned in prod
    await host(10, NOW - 40 * DAY, 30);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [{ start: NOW - 41 * DAY, end: NOW }],
      NOW,
    );
    expect(periods[0].measuredS).toBe(0);
  });

  it("dataStart seeks rollups and raw rows", async () => {
    await host(600, T0 + 1200, 5);
    await host(10, T0 + 600, 5);
    expect((await loadPowerData(e, ORG, range, NOW)).dataStart).toBe(T0 + 600);
  });

  it("sums rollup rows", async () => {
    await host(600, T0, 20, { max: 50 });
    await host(600, T0 + 600, 40, { samples: 30, max: 70 });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].measuredWs).toBe(20 * 600 + 40 * 300);
    expect(periods[0].measuredS).toBe(900);
    expect(periods[0].peakW).toBe(70);
  });

  it("raw rows fill a missing rollup bucket", async () => {
    await host(600, T0, 20);
    for (let i = 0; i < 6; i++) await host(10, T0 + 600 + i * 10, 30);
    // raw rows inside the rolled-up bucket are not double counted
    await host(10, T0 + 10, 99);
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].measuredWs).toBe(20 * 600 + 6 * 300);
    expect(periods[0].measuredS).toBe(660);
    expect(periods[0].peakW).toBe(30);
  });

  it("ok = 0 raw rows and other bindings are ignored", async () => {
    await host(10, T0, 30, { ok: 0 });
    await host(10, T0 + 10, null);
    await host(600, T0, 50, { binding: "OTHERBOX" });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0]).toMatchObject({
      measuredWs: 0,
      measuredS: 0,
      peakW: null,
    });
  });

  it("rows assigned to their period", async () => {
    await host(600, T0, 10);
    await host(600, T0 + 3600, 20);
    const { periods } = await loadPowerData(
      e,
      ORG,
      [
        { start: T0, end: T0 + 3600 },
        { start: T0 + 3600, end: NOW },
      ],
      NOW,
    );
    expect(periods.map((p) => p.measuredWs)).toEqual([6000, 12000]);
    expect(periods[1]).toMatchObject({ start: T0 + 3600, end: NOW });
  });

  it("dataStart is the first host row", async () => {
    await host(10, T0 + 30, 5);
    await host(600, T0 + 600, 5);
    expect((await loadPowerData(e, ORG, range, NOW)).dataStart).toBe(T0 + 30);
  });

  it("no rows gives null dataStart", async () => {
    expect((await loadPowerData(e, ORG, range, NOW)).dataStart).toBeNull();
  });
});

describe("loadPowerData tokens", () => {
  it("token sums skip errors, cache hits, other providers, other orgs and rows before dataStart", async () => {
    await host(600, T0 + 600, 10);
    await request(T0 + 700);
    await request(T0 + 800);
    await request(T0 + 900, { status: 500 });
    await request(T0 + 900, { cacheHit: 1 });
    await request(T0 + 900, { provider: "openai" });
    await request(T0 + 900, { org: OTHER });
    await request(T0 + 100); // before the first host sample
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].unpricedRequests).toBe(2);
    expect(periods[0].cloudUsd).toBe(0);
    expect(periods[0].tokens).toEqual({
      input: 2000,
      output: 400,
      cacheRead: 600,
      cacheWrite: 0,
      requests: 2,
    });
  });

  it("ignores a vpc provider on a binding the org may not use", async () => {
    await host(600, T0, 10);
    await provider(ORG, "elsewhere", { transport: "vpc", vpcBinding: "NOPE" });
    await request(T0 + 10, { provider: "elsewhere" });
    const { periods } = await loadPowerData(e, ORG, range, NOW);
    expect(periods[0].tokens.requests).toBe(0);
  });
});

describe("loadPowerData cloud pricing", () => {
  // each request: 1000 in, 200 out, 300 cache read, model 'm'
  it("prices from the provider's '*' row", async () => {
    await host(600, T0, 10);
    await price("local-m5", "*", [1, 4, 0.1, 2]);
    await request(T0 + 10);
    await request(T0 + 20);
    const data = await loadPowerData(e, ORG, range, NOW);
    expect(data.periods[0].cloudUsd).toBeCloseTo(
      (2 * (1000 * 1 + 200 * 4 + 300 * 0.1)) / 1e6,
    );
    expect(data.periods[0].unpricedRequests).toBe(0);
    expect(data.cloudRates).toEqual([
      {
        provider: "local-m5",
        model: "*",
        inputPer1m: 1,
        outputPer1m: 4,
        cacheReadPer1m: 0.1,
        cacheWritePer1m: 2,
      },
    ]);
  });

  it("an exact model row wins over '*'", async () => {
    await host(600, T0, 10);
    await price("local-m5", "*", [1, 4, 0.1, 0]);
    await price("local-m5", "m", [2, 8, 0, 0]);
    await request(T0 + 10);
    const data = await loadPowerData(e, ORG, range, NOW);
    expect(data.periods[0].cloudUsd).toBeCloseTo((1000 * 2 + 200 * 8) / 1e6);
    expect(data.cloudRates.map((r) => r.model)).toEqual(["*", "m"]);
  });

  it("other providers' rates are not used or listed", async () => {
    await host(600, T0, 10);
    await price("openai", "*", [1, 1, 1, 1]);
    await price("local-m5", "other", [1, 1, 1, 1]);
    await request(T0 + 10);
    const data = await loadPowerData(e, ORG, range, NOW);
    expect(data.periods[0].unpricedRequests).toBe(1);
    expect(data.periods[0].cloudUsd).toBe(0);
    expect(data.cloudRates.map((r) => r.provider)).toEqual(["local-m5"]);
  });
});

describe("loadPowerData idle and settings", () => {
  it("idle p10 nearest rank", async () => {
    for (let i = 1; i <= 10; i++) await host(600, NOW - i * 600, i);
    expect((await loadPowerData(e, ORG, range, NOW)).idleP10W).toBe(1);
    for (let i = 11; i <= 20; i++) await host(600, NOW - i * 600, i);
    await host(600, NOW - 40 * DAY, 0.5); // older than 30 days
    expect((await loadPowerData(e, ORG, range, NOW)).idleP10W).toBe(2);
  });

  it("no idle rows gives null", async () => {
    expect((await loadPowerData(e, ORG, range, NOW)).idleP10W).toBeNull();
  });

  it("reads power setting", async () => {
    expect((await loadPowerData(e, ORG, range, NOW)).settings).toEqual({});
    await env.DB.prepare(
      "INSERT INTO tenant_settings (organization_id, key, value) VALUES (?, 'power', ?)",
    )
      .bind(ORG, JSON.stringify({ pricePerKwhUsd: 0.2 }))
      .run();
    expect((await loadPowerData(e, ORG, range, NOW)).settings).toEqual({
      pricePerKwhUsd: 0.2,
    });
  });

  it("one round trip", async () => {
    const spy = vi.spyOn(e.DB, "batch");
    await loadPowerData(e, ORG, range, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("loadPowerData without a host binding", () => {
  it("org without host binding gets empty periods but its settings", async () => {
    await host(600, T0, 10);
    await env.DB.prepare(
      "INSERT INTO tenant_settings (organization_id, key, value) VALUES (?, 'power', ?)",
    )
      .bind(OTHER, JSON.stringify({ overheadW: 5 }))
      .run();
    const data = await loadPowerData(e, OTHER, range, NOW);
    expect(data).toEqual({
      settings: { overheadW: 5 },
      dataStart: null,
      idleP10W: null,
      cloudRates: [],
      periods: [
        {
          start: T0,
          end: NOW,
          measuredWs: 0,
          measuredS: 0,
          peakW: null,
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            requests: 0,
          },
          cloudUsd: 0,
          unpricedRequests: 0,
        },
      ],
    });
  });

  it("no periods reads settings only", async () => {
    const data = await loadPowerData(e, ORG, [], NOW);
    expect(data).toMatchObject({ dataStart: null, periods: [] });
  });
});
