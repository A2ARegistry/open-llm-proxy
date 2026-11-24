// [fork] W8: provider-wide pricing rows (model = '*').
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getModelPricing } from "~/src/metrics/cost-tracker";

async function price(provider: string, model: string, input: number) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO model_pricing
       (provider, model, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m)
     VALUES (?, ?, ?, ?, 0, 0)`,
  )
    .bind(provider, model, input, input)
    .run();
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS model_pricing (provider TEXT NOT NULL, model TEXT NOT NULL, input_per_1m REAL NOT NULL DEFAULT 0, output_per_1m REAL NOT NULL DEFAULT 0, cache_read_per_1m REAL NOT NULL DEFAULT 0, cache_write_per_1m REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider, model));",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM model_pricing;");
});

describe("getModelPricing", () => {
  it("uses a provider-wide '*' row when the model has no row", async () => {
    await price("local-m5", "*", 0);
    const pricing = await getModelPricing(env, "local-m5", "any-model");
    expect(pricing.inputPer1m).toBe(0);
    expect(pricing.outputPer1m).toBe(0);
  });

  it("prefers the exact model row over the provider-wide row", async () => {
    await price("local-m5", "*", 0);
    await price("local-m5", "big-model", 2);
    const pricing = await getModelPricing(env, "local-m5", "big-model");
    expect(pricing.inputPer1m).toBe(2);
  });

  it("falls back to the built-in default when neither row exists", async () => {
    const pricing = await getModelPricing(env, "other", "m");
    expect(pricing.provider).toBe("*");
    expect(pricing.inputPer1m).toBeGreaterThan(0);
  });
});
