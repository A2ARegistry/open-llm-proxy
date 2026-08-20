import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { tenantRouter } from "~/src/api/tenant";
import type { AppBindings } from "~/src/app";
import type { SessionAuth } from "~/src/types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER, metadata TEXT, system_prefix TEXT UNIQUE, custom_prefix TEXT UNIQUE, is_root_tenant INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, timestamp INTEGER NOT NULL DEFAULT 0);
`;

function session(orgId: string): SessionAuth {
  return {
    userId: "user_1",
    sessionId: "sess_1",
    organizationId: orgId,
    role: "owner",
    email: "owner@acme.test",
    expiresAt: 9999999999,
  };
}

function buildApp(orgId: string): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", (c, next) => {
    c.set("session", session(orgId));
    return next();
  });
  app.route("/api/tenant", tenantRouter);
  return app;
}

const request = (app: Hono<AppBindings>, path: string, init?: RequestInit) =>
  app.request(path, init, env as never);

async function insertOrg(
  id: string,
  over: { systemPrefix?: string; customPrefix?: string; isRoot?: boolean } = {},
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

beforeAll(async () => {
  for (const stmt of SCHEMA.split(";")) {
    if (stmt.trim()) await env.DB.exec(stmt);
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user_1', 'Owner', 'owner@acme.test', 1, 0, 0)",
  ).run();
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM audit_logs;");
  await env.DB.exec("DELETE FROM organizations;");
});

describe("GET /api/tenant", () => {
  it("returns root tenant info with empty base path", async () => {
    await insertOrg("org_root", { isRoot: true });
    const res = await request(buildApp("org_root"), "/api/tenant");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      organizationId: "org_root",
      isRoot: true,
      systemPrefix: null,
      customPrefix: null,
      basePath: "",
    });
  });

  it("prefers the custom prefix in the base path", async () => {
    await insertOrg("org_b", {
      systemPrefix: "proxy_abc123",
      customPrefix: "mybrand",
    });
    const res = await request(buildApp("org_b"), "/api/tenant");
    const body = await res.json();
    expect(body.basePath).toBe("mybrand");
  });
});

describe("PUT /api/tenant/prefix", () => {
  const put = (orgId: string, customPrefix: unknown) =>
    request(buildApp(orgId), "/api/tenant/prefix", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customPrefix }),
    });

  it("sets a valid custom prefix", async () => {
    await insertOrg("org_b", { systemPrefix: "proxy_abc123" });
    const res = await put("org_b", "mybrand");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customPrefix).toBe("mybrand");
  });

  it("rejects invalid, reserved and taken prefixes", async () => {
    await insertOrg("org_b", { systemPrefix: "proxy_abc123" });
    await insertOrg("org_c", { customPrefix: "taken-name" });

    expect((await put("org_b", "abc")).status).toBe(400);
    expect((await put("org_b", "proxy_xyz")).status).toBe(400);
    expect((await put("org_b", "v1")).status).toBe(400);
    expect((await put("org_b", "taken-name")).status).toBe(409);
  });

  it("does not allow a non-root tenant to clear its prefix", async () => {
    await insertOrg("org_b", { systemPrefix: "proxy_abc123" });
    const res = await put("org_b", null);
    expect(res.status).toBe(400);
  });

  it("lets the root tenant clear its prefix", async () => {
    await insertOrg("org_root", { isRoot: true, customPrefix: "mybrand" });
    const res = await put("org_root", null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customPrefix).toBeNull();
  });
});
