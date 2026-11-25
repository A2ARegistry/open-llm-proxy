// [fork] W12: BoxSampler samples the box every 10 s and flushes to D1.
import halogenHealth from "../../fixtures/live/halogen-health.json?raw";
import halogenMetrics from "../../fixtures/live/halogen-metrics.txt?raw";
import nodeMetrics from "../../fixtures/live/node-exporter-metrics.txt?raw";
import { createBoxTables } from "../live/box-schema";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoxSampler } from "~/src/durable/box-sampler";
import {
  BOX_SAMPLER_NAME,
  BUFFER_CAP,
  FLUSH_EVERY_TICKS,
} from "~/src/durable/box-sampler";

function upstream(routes: () => Record<string, string>) {
  return {
    fetch: vi.fn(async (url: string) => {
      const body = routes()[new URL(url).pathname];
      return body === undefined
        ? new Response("nope", { status: 404 })
        : new Response(body);
    }),
  };
}

function fakeEnv(bindings: Record<string, unknown>, db: unknown = env.DB) {
  return {
    ...env,
    DB: db,
    VPC_BINDINGS: "HALOGEN:org_a",
    HOST_METRICS_BINDINGS: "NODE:org_a",
    ...bindings,
  } as unknown as Env;
}

const healthy = () =>
  upstream(() => ({ "/health": halogenHealth, "/metrics": halogenMetrics }));
const node = () => upstream(() => ({ "/metrics": nodeMetrics }));

function stub() {
  return env.BOX_SAMPLER.get(
    env.BOX_SAMPLER.idFromName(`${BOX_SAMPLER_NAME}-${Math.random()}`),
  );
}

type Run = (sampler: BoxSampler, state: DurableObjectState) => Promise<void>;

async function inSampler(
  bindings: Record<string, unknown>,
  run: Run,
  db: unknown = env.DB,
) {
  await runInDurableObject(stub(), async (instance: BoxSampler, state) => {
    Object.defineProperty(instance, "env", {
      value: fakeEnv(bindings, db),
      configurable: true,
    });
    await run(instance, state);
  });
}

function buffered(state: DurableObjectState, kind: string): number {
  const row = state.storage.sql
    .exec("SELECT COUNT(*) AS n FROM pending WHERE kind = ?", kind)
    .one() as { n: number };
  return row.n;
}

async function count(table: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return r!.n;
}

function failingDb() {
  return {
    prepare: env.DB.prepare.bind(env.DB),
    batch: vi.fn().mockRejectedValue(new Error("d1 down")),
  };
}

beforeAll(async () => {
  // exec needs one statement per line.
  await createBoxTables(env.DB, ["inference_samples", "host_samples"]);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inference_samples");
  await env.DB.exec("DELETE FROM host_samples");
});

describe("BoxSampler", () => {
  it("ensureRunning sets one alarm", async () => {
    await inSampler({}, async (sampler, state) => {
      await sampler.ensureRunning();
      const first = await state.storage.getAlarm();
      expect(first).not.toBeNull();
      expect(first! % 10_000).toBe(0);
      await sampler.ensureRunning();
      expect(await state.storage.getAlarm()).toBe(first);
    });
  });

  it("buffers five ticks then flushes on the sixth", async () => {
    await inSampler(
      { HALOGEN: healthy(), NODE: node() },
      async (sampler, state) => {
        await sampler.ensureRunning();
        for (let i = 0; i < FLUSH_EVERY_TICKS - 1; i++) await sampler.alarm();
        expect(await count("inference_samples")).toBe(0);
        expect(buffered(state, "inference")).toBe(5);
        expect(buffered(state, "host")).toBe(5);
        await sampler.alarm();
        expect(await count("inference_samples")).toBe(6);
        expect(await count("host_samples")).toBe(6);
        expect(buffered(state, "inference")).toBe(0);
        const ts = await env.DB.prepare(
          "SELECT ts FROM inference_samples ORDER BY ts",
        ).all<{ ts: number }>();
        const steps = ts.results
          .slice(1)
          .map((r, i) => r.ts - ts.results[i].ts);
        expect(steps).toEqual([10, 10, 10, 10, 10]);
      },
    );
  });

  it("derives rates from the stored previous snapshot", async () => {
    let tick = 0;
    const halogen = upstream(() => ({
      "/health": halogenHealth,
      "/metrics": halogenMetrics
        .replace(
          "halogen:cache_hits_total 234",
          `halogen:cache_hits_total ${234 + tick * 10}`,
        )
        .replace(
          "halogen:cache_misses_total 11",
          `halogen:cache_misses_total ${11 + tick}`,
        ),
    }));
    await inSampler({ HALOGEN: halogen, NODE: node() }, async (sampler) => {
      await sampler.ensureRunning();
      await sampler.alarm();
      tick = 1;
      for (let i = 0; i < FLUSH_EVERY_TICKS - 1; i++) await sampler.alarm();
      const rows = await env.DB.prepare(
        "SELECT cache_hit_ratio FROM inference_samples ORDER BY ts",
      ).all<{ cache_hit_ratio: number | null }>();
      expect(rows.results[0].cache_hit_ratio).toBeNull();
      expect(rows.results[1].cache_hit_ratio).toBeCloseTo(10 / 11);
    });
  });

  it("writes ok=0 rows for a down source and forgets its previous snapshot", async () => {
    const dead = { fetch: vi.fn().mockRejectedValue(new Error("down")) };
    await inSampler({ HALOGEN: dead, NODE: node() }, async (sampler, state) => {
      await sampler.ensureRunning();
      for (let i = 0; i < FLUSH_EVERY_TICKS; i++) await sampler.alarm();
      const rows = await env.DB.prepare(
        "SELECT ok, in_flight FROM inference_samples",
      ).all<{ ok: number; in_flight: number | null }>();
      expect(rows.results).toHaveLength(6);
      expect(
        rows.results.every((r) => r.ok === 0 && r.in_flight === null),
      ).toBe(true);
      expect(await state.storage.get("prev:inference:HALOGEN")).toBeUndefined();
      expect(await state.storage.get("prev:host:NODE")).toBeDefined();
    });
  });

  it("keeps rows when the flush fails, retries, and reschedules", async () => {
    const db = failingDb();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await inSampler(
      { HALOGEN: healthy(), NODE: node() },
      async (sampler, state) => {
        await sampler.ensureRunning();
        for (let i = 0; i < FLUSH_EVERY_TICKS; i++) await sampler.alarm();
        expect(db.batch).toHaveBeenCalledTimes(1);
        expect(buffered(state, "inference")).toBe(6);
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(error).toHaveBeenCalled();
        // Retried at the flush cadence, not on every tick.
        for (let i = 0; i < FLUSH_EVERY_TICKS - 1; i++) await sampler.alarm();
        expect(db.batch).toHaveBeenCalledTimes(1);
        db.batch.mockImplementation((s: D1PreparedStatement[]) =>
          env.DB.batch(s),
        );
        await sampler.alarm();
        expect(db.batch).toHaveBeenCalledTimes(2);
        expect(buffered(state, "inference")).toBe(0);
        expect(await count("inference_samples")).toBe(12);
      },
      db,
    );
    error.mockRestore();
  });

  it("caps the buffer at the newest rows", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await inSampler(
      { HALOGEN: healthy(), NODE: node() },
      async (sampler, state) => {
        await sampler.ensureRunning();
        for (let i = 0; i < BUFFER_CAP + 40; i++) await sampler.alarm();
        expect(buffered(state, "inference")).toBe(BUFFER_CAP);
        expect(buffered(state, "host")).toBe(BUFFER_CAP);
        const span = state.storage.sql
          .exec(
            "SELECT MAX(ts) - MIN(ts) AS s FROM pending WHERE kind = 'inference'",
          )
          .one() as { s: number };
        expect(span.s).toBe((BUFFER_CAP - 1) * 10);
      },
      failingDb(),
    );
    error.mockRestore();
  });

  it("samples nothing when no binding is configured", async () => {
    await inSampler(
      { VPC_BINDINGS: "", HOST_METRICS_BINDINGS: "" },
      async (sampler, state) => {
        await sampler.alarm();
        expect(buffered(state, "inference")).toBe(0);
        expect(await state.storage.getAlarm()).not.toBeNull();
      },
    );
  });

  it("alarm without ensureRunning starts from the current boundary", async () => {
    await inSampler(
      { HALOGEN: healthy(), NODE: node() },
      async (sampler, state) => {
        await sampler.alarm();
        expect(buffered(state, "inference")).toBe(1);
        expect(await state.storage.getAlarm()).not.toBeNull();
      },
    );
  });

  it("stamps a late alarm with the current boundary", async () => {
    await inSampler(
      { HALOGEN: healthy(), NODE: node() },
      async (sampler, state) => {
        await state.storage.put("due", 10_000);
        const before = Math.floor(Date.now() / 10_000) * 10;
        await sampler.alarm();
        const after = Math.floor(Date.now() / 10_000) * 10;
        const row = state.storage.sql
          .exec("SELECT ts FROM pending WHERE kind = 'inference'")
          .one() as { ts: number };
        expect(row.ts).toBeGreaterThan(10);
        expect(row.ts).toBeGreaterThanOrEqual(before);
        expect(row.ts).toBeLessThanOrEqual(after);
      },
    );
  });
});
