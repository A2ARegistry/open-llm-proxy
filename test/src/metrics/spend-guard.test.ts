import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { TenantService } from "~/src/db/tenant";
import {
  maybeDisableAfterSpend,
  reconcileKeyDisable,
  reconcileTenantDisable,
  spendBlockReason,
} from "~/src/metrics/spend-guard";

const ORG = "org_spend_test";

function uniq(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function insertRequest(costUsd: number, ts: number) {
  await env.DB.prepare(
    `INSERT INTO request_metrics (id, organization_id, api_key_id, timestamp, provider, model, method, status_code, latency_ms, tokens_input, tokens_output, tokens_cached, cost_usd, error_message, cache_hit)
     VALUES (?, ?, ?, ?, 'openai', 'gpt-4', 'chat', 200, 100, 100, 50, 0, ?, NULL, 0)`,
  )
    .bind(`metric_${uniq()}`, ORG, `key_${uniq()}`, ts, costUsd)
    .run();
}

async function insertKey(keyId: string, spendCapUsd: number | null) {
  await env.DB.prepare(
    `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, status, scopes)
     VALUES (?, ?, 'spend-key', 'hash_${uniq()}', 'sk_live_', 'user_1', 1, 'active', ?)`,
  )
    .bind(
      keyId,
      ORG,
      JSON.stringify(spendCapUsd == null ? {} : { spendCapUsd }),
    )
    .run();
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}', spend_disabled_until INTEGER);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS tenant_settings (organization_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (organization_id, key));",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS request_metrics (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, user_id TEXT, api_key_id TEXT, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, method TEXT NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER, cost_usd REAL, error_message TEXT, cache_hit INTEGER NOT NULL DEFAULT 0);",
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM request_metrics;");
  await env.DB.exec("DELETE FROM api_keys;");
  await env.DB.exec("DELETE FROM tenant_settings;");
});

describe("spendBlockReason", () => {
  it("returns null when nothing is disabled", async () => {
    const keyId = `key_${uniq()}`;
    await insertKey(keyId, null);
    const block = await spendBlockReason(env as never, ORG, null);
    expect(block).toBeNull();
  });

  it("blocks when the key is disabled by a spend cap", async () => {
    const keyId = `key_${uniq()}`;
    await insertKey(keyId, null);
    const future = Math.floor(Date.now() / 1000) + 3600;
    await env.DB.prepare(
      "UPDATE api_keys SET spend_disabled_until = ? WHERE id = ?",
    )
      .bind(future, keyId)
      .run();
    const block = await spendBlockReason(env as never, ORG, future);
    expect(block).not.toBeNull();
    expect(block!.kind).toBe("key_cap");
  });

  it("blocks when the tenant is disabled", async () => {
    await insertKey(`key_${uniq()}`, null);
    const tenants = new TenantService(env.DB);
    const future = Math.floor(Date.now() / 1000) + 3600;
    await tenants.updateSettings(ORG, { spendDisabledUntil: future });
    const block = await spendBlockReason(env as never, ORG, null);
    expect(block).not.toBeNull();
    expect(block!.kind).toBe("tenant_daily");
  });
});

describe("maybeDisableAfterSpend", () => {
  it("disables the tenant when the daily limit is crossed", async () => {
    const tenants = new TenantService(env.DB);
    await tenants.updateSettings(ORG, {
      spendLimits: { dailyUsd: 1, monthlyUsd: undefined },
    });
    await insertRequest(1.5, Math.floor(Date.now() / 1000));
    await maybeDisableAfterSpend(env as never, ORG, `key_${uniq()}`, {});

    const settings = await tenants.getSettings(ORG);
    const until = settings.spendDisabledUntil as number | undefined;
    expect(until).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("disables the key when its lifetime cap is crossed", async () => {
    const keyId = `key_${uniq()}`;
    await insertKey(keyId, 1);
    await insertRequest(2, Math.floor(Date.now() / 1000) - 10);
    await maybeDisableAfterSpend(env as never, ORG, keyId, { spendCapUsd: 1 });

    const row = await env.DB.prepare(
      "SELECT spend_disabled_until FROM api_keys WHERE id = ?",
    )
      .bind(keyId)
      .first<{ spend_disabled_until: number | null }>();
    expect(row!.spend_disabled_until).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("reconcileTenantDisable", () => {
  it("clears the flag when spend is back under the limit", async () => {
    const tenants = new TenantService(env.DB);
    await tenants.updateSettings(ORG, {
      spendDisabledUntil: Math.floor(Date.now() / 1000) + 3600,
      spendLimits: { dailyUsd: 100, monthlyUsd: undefined },
    });
    await insertRequest(0.5, Math.floor(Date.now() / 1000));
    await reconcileTenantDisable(env as never, ORG);

    const settings = await tenants.getSettings(ORG);
    expect(settings.spendDisabledUntil as number | undefined).toBeFalsy();
  });
});

describe("reconcileKeyDisable", () => {
  it("clears the key flag when the cap is raised above spend", async () => {
    const keyId = `key_${uniq()}`;
    await insertKey(keyId, 1);
    await env.DB.prepare(
      "UPDATE api_keys SET spend_disabled_until = ? WHERE id = ?",
    )
      .bind(Math.floor(Date.now() / 1000) + 99999, keyId)
      .run();
    await insertRequest(0.5, Math.floor(Date.now() / 1000));
    await reconcileKeyDisable(env as never, ORG, keyId, 100);

    const row = await env.DB.prepare(
      "SELECT spend_disabled_until FROM api_keys WHERE id = ?",
    )
      .bind(keyId)
      .first<{ spend_disabled_until: number | null }>();
    expect(row!.spend_disabled_until).toBeNull();
  });
});
