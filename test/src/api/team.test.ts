import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll } from "vitest";
import { teamRouter } from "~/src/api/team";
import type { AppBindings } from "~/src/app";
import type { SessionAuth } from "~/src/types";

const ownerSession: SessionAuth = {
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: "org_1",
  role: "owner",
  email: "owner@acme.test",
  expiresAt: 9999999999,
};

const adminSession: SessionAuth = {
  userId: "user_2",
  sessionId: "sess_2",
  organizationId: "org_1",
  role: "admin",
  email: "admin@acme.test",
  expiresAt: 9999999999,
};

const memberSession: SessionAuth = {
  userId: "user_3",
  sessionId: "sess_3",
  organizationId: "org_1",
  role: "member",
  email: "member@acme.test",
  expiresAt: 9999999999,
};

function buildApp(session: SessionAuth): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", (c, next) => {
    c.set("session", session);
    // Stub the request-scoped auth instance so plugin calls are deterministic.
    c.set("auth", {
      api: {
        organization: {
          createInvitation: async ({ body }) => ({
            id: "inv_plugin",
            organizationId: body.organizationId,
            email: body.email,
            role: body.role,
            status: "pending",
            expiresAt: 9999999999,
          }),
          cancelInvitation: async () => ({ ok: true }),
          updateMemberRole: async ({ body }) => ({
            id: "member_stub",
            organizationId: body.organizationId,
            role: body.role,
          }),
          removeMember: async () => ({ ok: true }),
        },
      },
    } as never);
    return next();
  });
  app.route("/api/team", teamRouter);
  return app;
}

async function fetchJson(
  app: Hono<AppBindings>,
  path: string,
  init?: RequestInit,
) {
  const res = await app.request(path, init, env as never);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

beforeAll(async () => {
  await env.DB.exec(`
CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER, metadata TEXT);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL, activeOrganizationId TEXT);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, email TEXT NOT NULL, role TEXT, status TEXT NOT NULL, expiresAt INTEGER NOT NULL, inviterId TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, organization_id TEXT, user_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, timestamp INTEGER NOT NULL);
`);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO organizations (id, name, createdAt, updatedAt) VALUES ('org_1', 'Acme', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO users (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('user_1', 'Owner', 'owner@acme.test', 1, 1, 1),
              ('user_2', 'Admin', 'admin@acme.test', 1, 1, 1),
              ('user_3', 'Member', 'member@acme.test', 1, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO members (id, organizationId, userId, role, createdAt)
       VALUES ('m_owner', 'org_1', 'user_1', 'owner', 1),
              ('m_admin', 'org_1', 'user_2', 'admin', 2),
              ('m_member', 'org_1', 'user_3', 'member', 3)`,
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO invitations (id, organizationId, email, role, status, expiresAt, inviterId, createdAt)
       VALUES ('inv_1', 'org_1', 'sam@acme.test', 'member', 'pending', 9999999999, 'user_1', 4),
              ('inv_2', 'org_1', 'stale@acme.test', 'admin', 'pending', 100, 'user_1', 5),
              ('inv_3', 'org_9', 'other@acme.test', 'member', 'pending', 9999999999, 'user_1', 6)`,
    ),
  ]);
});

describe("GET /api/team/members", () => {
  it("lists members ordered owner/admin/member and flags the caller", async () => {
    const app = buildApp(memberSession);
    const { status, body } = await fetchJson(app, "/api/team/members");
    expect(status).toBe(200);
    expect(body.members.map((m: { email: string }) => m.email)).toEqual([
      "owner@acme.test",
      "admin@acme.test",
      "member@acme.test",
    ]);
    const self = body.members.find(
      (m: { email: string }) => m.email === "member@acme.test",
    );
    expect(self.self).toBe(true);
    expect(body.members.find((m: { email: string }) => m.email !== "member@acme.test").self).toBe(false);
  });
});

describe("GET /api/team/invitations", () => {
  it("returns only this org's invitations with an expired flag", async () => {
    const app = buildApp(memberSession);
    const { status, body } = await fetchJson(app, "/api/team/invitations");
    expect(status).toBe(200);
    expect(body.invitations).toHaveLength(2);
    const stale = body.invitations.find((i: { email: string }) => i.email === "stale@acme.test");
    expect(stale.expired).toBe(true);
    const live = body.invitations.find((i: { email: string }) => i.email === "sam@acme.test");
    expect(live.expired).toBe(false);
    expect(body.invitations.some((i: { id: string }) => i.id === "inv_3")).toBe(false);
  });
});

describe("POST /api/team/invitations", () => {
  it("rejects a malformed email and an invalid role", async () => {
    const app = buildApp(ownerSession);
    expect((await fetchJson(app, "/api/team/invitations", { method: "POST", body: JSON.stringify({ email: "nope" }) })).status).toBe(400);
    expect(
      (await fetchJson(app, "/api/team/invitations", {
        method: "POST",
        body: JSON.stringify({ email: "sam@acme.test", role: "owner" }),
      })).status,
    ).toBe(400);
  });

  it("creates an invitation and writes an audit trail", async () => {
    const app = buildApp(ownerSession);
    const { status, body } = await fetchJson(app, "/api/team/invitations", {
      method: "POST",
      body: JSON.stringify({ email: "pat@acme.test", role: "admin" }),
    });
    expect(status).toBe(201);
    expect(body.invitation.email).toBe("pat@acme.test");
    expect(body.invitation.role).toBe("admin");

    const audit = await env.DB.prepare(
      "SELECT action, resource_type, resource_id FROM audit_logs WHERE organization_id = 'org_1'",
    ).all<{ action: string; resource_type: string; resource_id: string }>();
    expect(audit.results.some((r) => r.action === "invite" && r.resource_id === "pat@acme.test")).toBe(true);
  });
});

describe("POST /api/team/invitations/:id/cancel", () => {
  it("cancels a pending invitation and audits it", async () => {
    const app = buildApp(adminSession);
    const { status, body } = await fetchJson(app, "/api/team/invitations/inv_1/cancel", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE resource_type = 'member' AND resource_id = 'inv_1'",
    ).first<{ action: string }>();
    expect(audit?.action).toBe("cancel_invite");
  });
});

describe("PATCH /api/team/members/:id/role", () => {
  it("blocks a member from changing roles", async () => {
    const app = buildApp(memberSession);
    const { status } = await fetchJson(app, "/api/team/members/m_admin/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    });
    expect(status).toBe(403);
  });

  it("returns 404 for a member not in the org", async () => {
    const app = buildApp(ownerSession);
    const { status } = await fetchJson(app, "/api/team/members/nonexistent/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });
    expect(status).toBe(404);
  });

  it("only lets the owner change an owner's role", async () => {
    const app = buildApp(adminSession);
    const { status } = await fetchJson(app, "/api/team/members/m_owner/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "member" }),
    });
    expect(status).toBe(403);
  });

  it("updates a member role and audits it (admin)", async () => {
    const app = buildApp(adminSession);
    const { status, body } = await fetchJson(app, "/api/team/members/m_member/role", {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    });
    expect(status).toBe(200);
    expect(body.member.role).toBe("admin");
    const audit = await env.DB.prepare(
      "SELECT details FROM audit_logs WHERE action = 'update' AND resource_id = 'm_member'",
    ).first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toEqual({ role: "admin" });
  });
});

describe("DELETE /api/team/members/:id", () => {
  it("returns 404 for a member not in the org", async () => {
    const app = buildApp(ownerSession);
    const { status } = await fetchJson(app, "/api/team/members/nope", { method: "DELETE" });
    expect(status).toBe(404);
  });

  it("blocks removing yourself", async () => {
    const app = buildApp(adminSession);
    const { status } = await fetchJson(app, "/api/team/members/m_admin", { method: "DELETE" });
    expect(status).toBe(400);
  });

  it("only the owner can remove the owner", async () => {
    const app = buildApp(adminSession);
    const { status } = await fetchJson(app, "/api/team/members/m_owner", { method: "DELETE" });
    expect(status).toBe(403);
  });

  it("removes a member via the plugin and audits it", async () => {
    const app = buildApp(ownerSession);
    const { status, body } = await fetchJson(app, "/api/team/members/m_admin", { method: "DELETE" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE action = 'remove' AND resource_id = 'm_admin'",
    ).first<{ action: string }>();
    expect(audit?.action).toBe("remove");
  });
});

describe("POST /api/team/transfer-ownership", () => {
  it("rejects non-owners", async () => {
    const app = buildApp(adminSession);
    const { status } = await fetchJson(app, "/api/team/transfer-ownership", {
      method: "POST",
      body: JSON.stringify({ memberId: "m_member" }),
    });
    expect(status).toBe(403);
  });

  it("returns 404 for unknown members and 409 if already owner", async () => {
    const app = buildApp(ownerSession);
    expect(
      (await fetchJson(app, "/api/team/transfer-ownership", {
        method: "POST",
        body: JSON.stringify({ memberId: "ghost" }),
      })).status,
    ).toBe(404);
    expect(
      (await fetchJson(app, "/api/team/transfer-ownership", {
        method: "POST",
        body: JSON.stringify({ memberId: "m_owner" }),
      })).status,
    ).toBe(409);
  });

  it("atomically swaps owner and previous owner to admin", async () => {
    const app = buildApp(ownerSession);
    const { status, body } = await fetchJson(app, "/api/team/transfer-ownership", {
      method: "POST",
      body: JSON.stringify({ memberId: "m_member" }),
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const rows = await env.DB.prepare(
      "SELECT id, role FROM members WHERE organizationId = 'org_1'",
    ).all<{ id: string; role: string }>();
    expect(rows.results.find((r) => r.id === "m_owner")?.role).toBe("admin");
    expect(rows.results.find((r) => r.id === "m_member")?.role).toBe("owner");

    const audit = await env.DB.prepare(
      "SELECT action, resource_id FROM audit_logs WHERE action = 'transfer_ownership'",
    ).first<{ action: string; resource_id: string }>();
    expect(audit?.resource_id).toBe("m_member");
  });
});