// [fork] W12: sample store writes, rollup and prune.
import { createBoxTables } from "./box-schema";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_COLUMNS,
  INFERENCE_COLUMNS,
  toHostRow,
  toInferenceRow,
  type HostSampleRow,
  type InferenceSampleRow,
} from "~/src/live/sample-row";
import {
  insertStatements,
  pruneOld,
  rollupRecent,
  writeSamples,
} from "~/src/live/sample-store";

const e = env as unknown as Env;
const NOW = 100_000;

function inf(ts: number, over: Partial<InferenceSampleRow> = {}) {
  return {
    ...toInferenceRow("HALOGEN", ts, null, null),
    ok: 1 as const,
    slots: 4,
    version: "v1",
    in_flight: 1,
    queued: 0,
    ...over,
    ts,
  };
}

function host(ts: number, over: Partial<HostSampleRow> = {}): HostSampleRow {
  return {
    ...toHostRow("HALOGEN", ts, null, null),
    ok: 1,
    cpu_busy_pct: 10,
    gpu_power_w: 50,
    ...over,
    ts,
  };
}

async function count(table: string, resolution: number): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE resolution_s = ?`,
  )
    .bind(resolution)
    .first<{ n: number }>();
  return r!.n;
}

beforeAll(async () => {
  await createBoxTables(env.DB, ["inference_samples", "host_samples"]);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inference_samples");
  await env.DB.exec("DELETE FROM host_samples");
  vi.restoreAllMocks();
});

describe("column lists", () => {
  it("cover every key of the row types exactly once", () => {
    const infKeys = Object.keys(toInferenceRow("B", 0, null, null)).sort();
    expect([...INFERENCE_COLUMNS].sort()).toEqual(infKeys);
    const hostKeys = Object.keys(toHostRow("B", 0, null, null)).sort();
    expect([...HOST_COLUMNS].sort()).toEqual(hostKeys);
  });
});

describe("writeSamples", () => {
  it("writes rows in one batch", async () => {
    const spy = vi.spyOn(env.DB, "batch");
    const ts = [0, 10, 20, 30, 40, 50];
    await writeSamples(
      e,
      ts.map((t) => inf(t)),
      ts.map((t) => host(t)),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await count("inference_samples", 10)).toBe(6);
    expect(await count("host_samples", 10)).toBe(6);
  });

  it("is a no-op when empty", async () => {
    const spy = vi.spyOn(env.DB, "batch");
    await writeSamples(e, [], []);
    expect(spy).not.toHaveBeenCalled();
  });

  it("chunks under the param limit", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => inf(i * 10));
    const statements = insertStatements(e, rows, []);
    // 13 bound columns -> 7 rows (91 params) per statement.
    expect(statements.length).toBe(Math.ceil(50 / 7));
    await env.DB.batch(statements);
    expect(await count("inference_samples", 10)).toBe(50);
  });

  it("stores nulls and replaces on the same key", async () => {
    await writeSamples(e, [inf(0, { queued: 3 })], []);
    await writeSamples(e, [inf(0, { queued: 5 })], []);
    const r = await env.DB.prepare(
      "SELECT queued, version FROM inference_samples",
    ).all<{ queued: number; version: string }>();
    expect(r.results).toEqual([{ queued: 5, version: "v1" }]);
  });
});

describe("rollupRecent", () => {
  it("rolls up avg, max and samples", async () => {
    const rows: InferenceSampleRow[] = [];
    for (let i = 0; i < 59; i++) rows.push(inf(1200 + i * 10, { queued: i }));
    rows.push(inf(1200 + 59 * 10, { ok: 0, queued: null, in_flight: null }));
    const hosts = Array.from({ length: 60 }, (_, i) =>
      host(1200 + i * 10, { cpu_busy_pct: i }),
    );
    await writeSamples(e, rows, hosts);
    await rollupRecent(e, 2400 + 100);
    const r = await env.DB.prepare(
      "SELECT * FROM inference_samples WHERE resolution_s = 600",
    ).all<Record<string, number | string | null>>();
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      ts: 1200,
      ok: 1,
      samples: 59,
      queued: 29,
      queued_max: 58,
      in_flight: 1,
      in_flight_max: 1,
      slots: 4,
      version: "v1",
    });
    const h = await env.DB.prepare(
      "SELECT * FROM host_samples WHERE resolution_s = 600",
    ).first<Record<string, number | null>>();
    expect(h).toMatchObject({
      ts: 1200,
      samples: 60,
      cpu_busy_pct: 29.5,
      cpu_busy_pct_max: 59,
      gpu_power_w: 50,
      gpu_power_w_max: 50,
    });
  });

  it("is idempotent and counts partial buckets", async () => {
    await writeSamples(
      e,
      Array.from({ length: 20 }, (_, i) => inf(1200 + i * 10)),
      [],
    );
    await rollupRecent(e, 2400 + 100);
    await rollupRecent(e, 2400 + 100);
    expect(await count("inference_samples", 600)).toBe(1);
    const r = await env.DB.prepare(
      "SELECT samples FROM inference_samples WHERE resolution_s = 600",
    ).first<{ samples: number }>();
    expect(r!.samples).toBe(20);
  });

  it("marks an all-failed bucket ok = 0 with zero samples", async () => {
    await writeSamples(e, [inf(1200, { ok: 0, queued: null })], []);
    await rollupRecent(e, 2500);
    const r = await env.DB.prepare(
      "SELECT ok, samples, queued FROM inference_samples WHERE resolution_s = 600",
    ).first<{ ok: number; samples: number; queued: number | null }>();
    expect(r).toEqual({ ok: 0, samples: 0, queued: null });
  });

  it("skips the open bucket", async () => {
    await writeSamples(e, [inf(NOW - 30)], [host(NOW - 30)]);
    await rollupRecent(e, NOW);
    expect(await count("inference_samples", 600)).toBe(0);
    expect(await count("host_samples", 600)).toBe(0);
  });
});

describe("pruneOld", () => {
  it("deletes old 10 s rows, keeping a rollup and recent rows", async () => {
    const old = NOW + 40 * 86400;
    const oldTs = old - 31 * 86400;
    const recentTs = old - 86400;
    await writeSamples(
      e,
      [inf(oldTs), inf(oldTs + 10), inf(recentTs)],
      [host(oldTs), host(recentTs)],
    );
    await pruneOld(e, old);
    const raw = await env.DB.prepare(
      "SELECT ts FROM inference_samples WHERE resolution_s = 10",
    ).all<{ ts: number }>();
    expect(raw.results.map((r) => r.ts)).toEqual([recentTs]);
    const roll = await env.DB.prepare(
      "SELECT ts, samples FROM inference_samples WHERE resolution_s = 600",
    ).all<{ ts: number; samples: number }>();
    expect(roll.results).toEqual([
      { ts: Math.floor(oldTs / 600) * 600, samples: 2 },
    ]);
    expect(await count("host_samples", 10)).toBe(1);
    expect(await count("host_samples", 600)).toBe(1);
  });

  it("does not recompute a bucket from fewer rows on a later prune", async () => {
    const old = NOW + 40 * 86400;
    const oldTs = old - 31 * 86400;
    await writeSamples(e, [inf(oldTs), inf(oldTs + 10)], []);
    await pruneOld(e, old);
    await pruneOld(e, old + 86400);
    const r = await env.DB.prepare(
      "SELECT samples FROM inference_samples WHERE resolution_s = 600",
    ).first<{ samples: number }>();
    expect(r!.samples).toBe(2);
  });
});
