// [fork] W12: cron keeps the sampler alive, rolls up and prunes daily.
import migration from "../../../migrations/0006_box_samples.sql?raw";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BOX_SAMPLER_NAME } from "~/src/durable/box-sampler";
import { pruneDue, runHistoryMaintenance } from "~/src/live/history-cron";
import { toInferenceRow } from "~/src/live/sample-row";
import { insertStatements } from "~/src/live/sample-store";

const e = env as unknown as Env;
const at = (hhmm: string) => Date.parse(`2026-11-24T${hhmm}:00Z`);
const DAY = "2026-11-24";
const MARKER = `live-history:pruned:${DAY}`;

function infRow(ts: number) {
  return { ...toInferenceRow("HALOGEN", ts, null, null), ok: 1 as const };
}

async function seed(ts: number) {
  await env.DB.batch(insertStatements(e, [infRow(ts)], []));
}

async function count(resolution: number): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM inference_samples WHERE resolution_s = ?",
  )
    .bind(resolution)
    .first<{ n: number }>();
  return r!.n;
}

beforeAll(async () => {
  for (const table of [
    "inference_samples",
    "host_samples",
    "throughput_rollups",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
    const create = migration
      .split(";")
      .map((s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim())
      .find((s) => s.startsWith(`CREATE TABLE ${table} `))!;
    await env.DB.exec(create);
  }
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, provider TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, UNIQUE(organization_id, provider));",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM inference_samples");
  await env.SESSION_CACHE.delete(MARKER);
  vi.restoreAllMocks();
});

describe("pruneDue", () => {
  it("is true from 03:00 UTC", () => {
    expect(pruneDue(at("02:59"))).toBe(false);
    expect(pruneDue(at("03:00"))).toBe(true);
    expect(pruneDue(at("23:59"))).toBe(true);
  });
});

describe("runHistoryMaintenance", () => {
  it("keeps sampler alive", async () => {
    await runHistoryMaintenance(e, at("12:00"));
    const stub = env.BOX_SAMPLER.get(
      env.BOX_SAMPLER.idFromName(BOX_SAMPLER_NAME),
    );
    const alarm = await runInDurableObject(stub, (_i, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
  });

  it("rolls up every run", async () => {
    await seed(at("11:10") / 1000);
    await runHistoryMaintenance(e, at("12:00"));
    expect(await count(600)).toBe(1);
  });

  it("prunes once per day after 03:00 UTC", async () => {
    const old = at("12:00") / 1000 - 40 * 86_400;
    await seed(old);
    await runHistoryMaintenance(e, at("02:55"));
    expect(await count(10)).toBe(1);
    expect(await env.SESSION_CACHE.get(MARKER)).toBeNull();

    await runHistoryMaintenance(e, at("03:05"));
    expect(await count(10)).toBe(0);
    expect(await env.SESSION_CACHE.get(MARKER)).not.toBeNull();

    await seed(old);
    await runHistoryMaintenance(e, at("03:10"));
    expect(await count(10)).toBe(1);
  });

  it("does not set the marker when pruning fails", async () => {
    const failing = {
      ...env,
      DB: { batch: vi.fn().mockRejectedValue(new Error("d1 down")) },
    } as unknown as Env;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runHistoryMaintenance(failing, at("03:05"));
    expect(await env.SESSION_CACHE.get(MARKER)).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("one failing step does not stop the others", async () => {
    await seed(at("11:10") / 1000);
    const broken = {
      ...env,
      BOX_SAMPLER: {
        idFromName: () => "x",
        get: () => ({
          ensureRunning: () => Promise.reject(new Error("do down")),
        }),
      },
    } as unknown as Env;
    await runHistoryMaintenance(broken, at("12:00"));
    expect(await count(600)).toBe(1);
  });
});
