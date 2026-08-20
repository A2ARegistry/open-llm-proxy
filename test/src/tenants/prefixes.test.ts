import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  assignTenantPrefixes,
  generateSystemPrefix,
  getTenantPrefixInfo,
  resolveTenantByPrefix,
  validateCustomPrefix,
  ROOT_TENANT_SETTING,
} from "~/src/tenants/prefixes";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER, metadata TEXT, system_prefix TEXT UNIQUE, custom_prefix TEXT UNIQUE, is_root_tenant INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
`;

async function insertOrg(id: string, over: Record<string, unknown> = {}) {
  await env.DB.prepare(
    `INSERT INTO organizations (id, name, createdAt, is_root_tenant, system_prefix, custom_prefix)
     VALUES (?, 'Org', 0, 0, NULL, NULL)`,
  )
    .bind(id)
    .run();
  if (Object.keys(over).length) {
    await env.DB.prepare(
      `UPDATE organizations SET system_prefix = ?, custom_prefix = ?, is_root_tenant = ?
       WHERE id = ?`,
    )
      .bind(
        (over.systemPrefix as string | null) ?? null,
        (over.customPrefix as string | null) ?? null,
        over.isRoot ? 1 : 0,
        id,
      )
      .run();
  }
}

beforeAll(async () => {
  for (const stmt of SCHEMA.split(";")) {
    if (stmt.trim()) await env.DB.exec(stmt);
  }
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM organizations;");
  await env.DB.exec("DELETE FROM system_settings;");
});

describe("generateSystemPrefix / validateCustomPrefix", () => {
  it("generates proxy_ + 6 lowercase alphanumeric chars", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSystemPrefix()).toMatch(/^proxy_[a-z0-9]{6}$/);
    }
  });

  it("accepts valid custom prefixes", () => {
    expect(validateCustomPrefix("acme-api")).toBeNull();
    expect(validateCustomPrefix("myorg2")).toBeNull();
  });

  it("rejects short, invalid and reserved names", () => {
    expect(validateCustomPrefix("abc")).toMatch(/at least 6/);
    expect(validateCustomPrefix("Bad_Name!")).toMatch(/lowercase/);
    expect(validateCustomPrefix("proxy_abc")).toMatch(/lowercase/);
    expect(validateCustomPrefix("models")).toMatch(/reserved/);
    expect(validateCustomPrefix("settings")).toMatch(/reserved/);
  });
});

describe("assignTenantPrefixes", () => {
  it("marks the first org as root and gives later orgs a system prefix", async () => {
    await insertOrg("org_first");
    await assignTenantPrefixes(env, "org_first");
    const first = await getTenantPrefixInfo(env, "org_first");
    expect(first?.isRoot).toBe(true);
    expect(first?.systemPrefix).toBeNull();

    await insertOrg("org_second");
    await assignTenantPrefixes(env, "org_second");
    const second = await getTenantPrefixInfo(env, "org_second");
    expect(second?.isRoot).toBe(false);
    expect(second?.systemPrefix).toMatch(/^proxy_[a-z0-9]{6}$/);

    const rootSetting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = ?",
    )
      .bind(ROOT_TENANT_SETTING)
      .first<{ value: string }>();
    expect(rootSetting?.value).toBe("org_first");
  });
});

describe("resolveTenantByPrefix", () => {
  it("resolves custom prefix first, then system prefix", async () => {
    await insertOrg("org_a", { systemPrefix: "proxy_aaaaaa" });
    await insertOrg("org_b", {
      systemPrefix: "proxy_bbbbbb",
      customPrefix: "mybrand",
    });

    const byCustom = await resolveTenantByPrefix(env, "mybrand");
    expect(byCustom?.organizationId).toBe("org_b");
    const bySystem = await resolveTenantByPrefix(env, "proxy_bbbbbb");
    expect(bySystem?.organizationId).toBe("org_b");
    expect(await resolveTenantByPrefix(env, "nope")).toBeNull();
  });

  it("returns null for the root tenant's empty path", async () => {
    await insertOrg("org_root", { isRoot: true });
    expect(await resolveTenantByPrefix(env, "")).toBeNull();
  });
});
