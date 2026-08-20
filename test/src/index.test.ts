import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sha256Hex } from "~/src/utils/crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, activeOrganizationId TEXT);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER, metadata TEXT, system_prefix TEXT UNIQUE, custom_prefix TEXT UNIQUE, is_root_tenant INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT, status TEXT NOT NULL, expiresAt INTEGER NOT NULL, inviterId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, spend_disabled_until INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS provider_configs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, provider TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, UNIQUE(organization_id, provider));
CREATE TABLE IF NOT EXISTS tenant_settings (organization_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (organization_id, key));
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, timestamp INTEGER NOT NULL DEFAULT 0);
`;

beforeAll(async () => {
  for (const stmt of SCHEMA.split(";")) {
    if (stmt.trim()) await env.DB.exec(stmt);
  }
});

describe("worker dispatch (V2)", () => {
  it("serves the bootstrap status endpoint through the Hono app", async () => {
    const res = await SELF.fetch("http://example.com/api/bootstrap/status", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.initialized).toBe(true);
    expect(body.defaultCredentials?.email).toBe("admin@example.com");
  });

  it("returns 401 for unauthenticated /v1/models requests", async () => {
    const res = await SELF.fetch("http://example.com/v1/models", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("returns JSON 404 for unknown API paths", async () => {
    const res = await SELF.fetch("http://example.com/api/nope", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("serves the dashboard SPA for browser requests at /", async () => {
    const res = await SELF.fetch("http://example.com/", {
      headers: { accept: "text/html" },
    });
    expect(res.status).toBe(200);
  });
});

describe("tenant prefix routing", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM api_keys;");
    await env.DB.exec("DELETE FROM organizations;");
    await env.DB.exec("DELETE FROM system_settings;");
  });

  async function insertOrg(
    id: string,
    over: {
      systemPrefix?: string;
      customPrefix?: string;
      isRoot?: boolean;
    } = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO organizations (id, name, createdAt, is_root_tenant, system_prefix, custom_prefix)
       VALUES (?, 'Org', 0, ?, ?, ?)`,
    )
      .bind(
        id,
        over.isRoot ? 1 : 0,
        over.systemPrefix ?? null,
        over.customPrefix ?? null,
      )
      .run();
  }

  async function insertKey(
    id: string,
    orgId: string,
    key: string,
    scopes: unknown = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, scopes)
       VALUES (?, ?, 'k', ?, ?, 'user_1', 0, ?)`,
    )
      .bind(
        id,
        orgId,
        await sha256Hex(key),
        key.slice(0, 8),
        JSON.stringify(scopes),
      )
      .run();
  }

  const chat = (path: string, key: string, model: string) =>
    SELF.fetch(`http://example.com${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  it("allows the root tenant on the plain path", async () => {
    await insertOrg("org_root", { isRoot: true });
    await insertKey("k_root", "org_root", "sk_root");
    const res = await chat("/v1/chat/completions", "sk_root", "openai/gpt-4o");
    expect(res.status).toBe(400); // provider 'openai' not configured, not an auth error
    const body = await res.json();
    expect(body.error.message).toMatch(/openai/i);
  });

  it("routes a prefixed path to the matching tenant and enforces the key tenant", async () => {
    await insertOrg("org_root", { isRoot: true });
    await insertKey("k_root", "org_root", "sk_root");
    await insertOrg("org_b", { systemPrefix: "proxy_abc123" });
    await insertKey("k_b", "org_b", "sk_b");

    const ok = await chat(
      "/proxy_abc123/v1/chat/completions",
      "sk_b",
      "openai/gpt-4o",
    );
    expect(ok.status).toBe(400); // routed to org_b, openai not configured
    expect((await ok.json()).error.message).toMatch(/openai/i);

    const wrongTenant = await chat(
      "/proxy_abc123/v1/chat/completions",
      "sk_root",
      "openai/gpt-4o",
    );
    expect(wrongTenant.status).toBe(403);
    expect((await wrongTenant.json()).error.message).toMatch(/prefix/i);
  });

  it("rejects a non-root tenant on the plain path with a hint", async () => {
    await insertOrg("org_b", { systemPrefix: "proxy_abc123" });
    await insertKey("k_b", "org_b", "sk_b");
    const res = await chat("/v1/chat/completions", "sk_b", "openai/gpt-4o");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toMatch(/proxy_abc123/);
  });

  it("returns 404 for an unknown prefix", async () => {
    await insertOrg("org_root", { isRoot: true });
    await insertKey("k_root", "org_root", "sk_root");
    const res = await chat(
      "/does-not-exist/v1/chat/completions",
      "sk_root",
      "openai/gpt-4o",
    );
    expect(res.status).toBe(404);
  });

  it("binds a key with scopes.defaultProvider to that provider", async () => {
    await insertOrg("org_root", { isRoot: true });
    await insertKey("k_openai", "org_root", "sk_openai", {
      defaultProvider: "openai",
    });

    const mismatch = await chat(
      "/v1/chat/completions",
      "sk_openai",
      "anthropic/claude",
    );
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()).error.message).toMatch(/bound to provider/);

    const bare = await chat("/v1/chat/completions", "sk_openai", "gpt-4o");
    expect(bare.status).toBe(400); // resolved to openai, which is not configured
    expect((await bare.json()).error.message).toMatch(/openai/i);
  });

  it("rejects a bare model id for an unbound key", async () => {
    await insertOrg("org_root", { isRoot: true });
    await insertKey("k_root", "org_root", "sk_root");
    const res = await chat("/v1/chat/completions", "sk_root", "gpt-4o");
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/provider\/model/);
  });
});
