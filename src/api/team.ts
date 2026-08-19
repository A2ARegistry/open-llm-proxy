import type { AppBindings } from "../app";
import { auditLog } from "../audit/audit-logger";
import { AppAuth, getAuthFor } from "../auth/setup";
import { nowSeconds } from "../utils/crypto";
import type { Context } from "hono";
import { Hono } from "hono";

const INVITE_ROLES = ["member", "admin", "viewer"] as const;
const ID_RE = /^[a-z0-9_]{1,64}$/i;

function isAdmin(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

type MemberRow = {
  id: string;
  userId: string;
  role: string;
  createdAt: number;
  name: string;
  email: string;
  image: string | null;
};

type InvitationRow = {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: number;
  inviterId: string;
  createdAt: number;
};

function publicInvitationView(row: InvitationRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expiresAt,
    inviterId: row.inviterId,
    createdAt: row.createdAt,
    expired: row.expiresAt < nowSeconds(),
  };
}

/** Reuse the request-scoped auth instance when available. */
function authFor(c: Context<AppBindings>): Promise<AppAuth> {
  return c.get("auth") ?? getAuthFor(c.env);
}

/** Run a Better Auth organization plugin call, mapping failures to HTTP errors. */
async function runOrgCall(
  c: Context<AppBindings>,
  fn: (auth: AppAuth) => Promise<unknown>,
) {
  try {
    return await fn(await authFor(c));
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message =
      typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "Organization operation failed";
    if (status && status >= 400 && status < 500) {
      return c.json({ error: message }, status as 400 | 401 | 403 | 404 | 409);
    }
    throw err;
  }
}

export const teamRouter = new Hono<AppBindings>();

// GET /api/team/members — list org members (owner/admin/member/viewer can view).
teamRouter.get("/members", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.userId, m.role, m.createdAt, u.name, u.email, u.image
     FROM members m
     JOIN users u ON u.id = m.userId
     WHERE m.organizationId = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.createdAt ASC`,
  )
    .bind(orgId)
    .all<MemberRow>();
  return c.json({
    members: results.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      createdAt: m.createdAt,
      name: m.name,
      email: m.email,
      image: m.image,
      self: m.userId === session.userId,
    })),
  });
});

// GET /api/team/invitations — list pending (or all) invitations.
teamRouter.get("/invitations", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, role, status, expiresAt, inviterId, createdAt
     FROM invitations WHERE organizationId = ? ORDER BY createdAt DESC`,
  )
    .bind(orgId)
    .all<InvitationRow>();
  return c.json({ invitations: results.map(publicInvitationView) });
});

// POST /api/team/invitations — invite someone by email (owner/admin).
teamRouter.post("/invitations", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  if (!isAdmin(session.role)) {
    return c.json({ error: "Requires owner or admin role" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    email?: unknown;
    role?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "A valid email is required" }, 400);
  }
  const role = (body.role ?? "member") as string;
  if (!INVITE_ROLES.includes(role as (typeof INVITE_ROLES)[number])) {
    return c.json(
      {
        error: `role must be one of: ${INVITE_ROLES.join(", ")}`,
      },
      400,
    );
  }

  const result = await runOrgCall(c, (auth) =>
    // Better Auth infers org-plugin endpoints at runtime; content-auth's
    // AppAuth type doesn't surface them, so cast to the plugin API shape.
    (
      auth as unknown as {
        api: {
          organization: {
            createInvitation: (args: {
              headers: Headers;
              body: {
                organizationId: string;
                email: string;
                role: string;
              };
            }) => Promise<unknown>;
          };
        };
      }
    ).api.organization.createInvitation({
      headers: c.req.raw.headers,
      body: { organizationId: orgId, email, role },
    }),
  );
  if (result instanceof Response) return result;

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "invite",
    resourceType: "member",
    resourceId: email,
    details: { role },
  });

  return c.json({ invitation: result }, 201);
});

// POST /api/team/invitations/:id/cancel — revoke a pending invitation.
teamRouter.post("/invitations/:id/cancel", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  if (!isAdmin(session.role)) {
    return c.json({ error: "Requires owner or admin role" }, 403);
  }
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Invalid invitation id" }, 400);

  const result = await runOrgCall(c, (auth) =>
    (
      auth as unknown as {
        api: {
          organization: {
            cancelInvitation: (args: {
              headers: Headers;
              body: { organizationId: string; invitationId: string };
            }) => Promise<unknown>;
          };
        };
      }
    ).api.organization.cancelInvitation({
      headers: c.req.raw.headers,
      body: { organizationId: orgId, invitationId: id },
    }),
  );
  if (result instanceof Response) return result;

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "cancel_invite",
    resourceType: "member",
    resourceId: id,
  });

  return c.json({ ok: true });
});

// PATCH /api/team/members/:id/role — change a member's role (owner/admin).
teamRouter.patch("/members/:id/role", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  if (!isAdmin(session.role)) {
    return c.json({ error: "Requires owner or admin role" }, 403);
  }
  const memberId = c.req.param("id");
  if (!ID_RE.test(memberId)) return c.json({ error: "Invalid member id" }, 400);

  const body = (await c.req.json().catch(() => null)) as {
    role?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  const role = body.role as string;
  if (!INVITE_ROLES.includes(role as (typeof INVITE_ROLES)[number])) {
    return c.json(
      { error: `role must be one of: ${INVITE_ROLES.join(", ")}` },
      400,
    );
  }

  // Only the owner may change an owner's role.
  const target = await c.env.DB.prepare(
    "SELECT role FROM members WHERE id = ? AND organizationId = ?",
  )
    .bind(memberId, orgId)
    .first<{ role: string }>();
  if (!target) return c.json({ error: "Member not found" }, 404);
  if (target.role === "owner" && session.role !== "owner") {
    return c.json(
      { error: "Only the organization owner can change an owner's role" },
      403,
    );
  }

  const result = await runOrgCall(c, (auth) =>
    (
      auth as unknown as {
        api: {
          organization: {
            updateMemberRole: (args: {
              headers: Headers;
              body: {
                organizationId: string;
                memberId: string;
                role: string;
              };
            }) => Promise<unknown>;
          };
        };
      }
    ).api.organization.updateMemberRole({
      headers: c.req.raw.headers,
      body: { organizationId: orgId, memberId, role },
    }),
  );
  if (result instanceof Response) return result;

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "update",
    resourceType: "member",
    resourceId: memberId,
    details: { role },
  });

  return c.json({ member: result });
});

// DELETE /api/team/members/:id — remove a member from the org (owner/admin).
teamRouter.delete("/members/:id", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  if (!isAdmin(session.role)) {
    return c.json({ error: "Requires owner or admin role" }, 403);
  }
  const memberId = c.req.param("id");
  if (!ID_RE.test(memberId)) return c.json({ error: "Invalid member id" }, 400);

  // Protect the owner: only an owner can remove the owner, and never if
  // they would leave the org with no owner.
  const target = await c.env.DB.prepare(
    "SELECT id, userId, role FROM members WHERE id = ? AND organizationId = ?",
  )
    .bind(memberId, orgId)
    .first<{ id: string; userId: string; role: string }>();
  if (!target) return c.json({ error: "Member not found" }, 404);

  if (target.role === "owner" && session.role !== "owner") {
    return c.json(
      { error: "Only the organization owner can remove the owner" },
      403,
    );
  }
  if (target.userId === session.userId) {
    return c.json(
      { error: "Use the leave-organization flow to remove yourself" },
      400,
    );
  }
  if (target.role === "owner") {
    const owners = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM members WHERE organizationId = ? AND role = 'owner'",
    )
      .bind(orgId)
      .first<{ n: number }>();
    if (!owners || owners.n <= 1) {
      return c.json(
        { error: "Cannot remove the last owner. Transfer ownership first." },
        409,
      );
    }
  }

  const result = await runOrgCall(c, (auth) =>
    (
      auth as unknown as {
        api: {
          organization: {
            removeMember: (args: {
              headers: Headers;
              body: {
                organizationId: string;
                memberIdOrEmail: string;
              };
            }) => Promise<unknown>;
          };
        };
      }
    ).api.organization.removeMember({
      headers: c.req.raw.headers,
      body: { organizationId: orgId, memberIdOrEmail: memberId },
    }),
  );
  if (result instanceof Response) return result;

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "remove",
    resourceType: "member",
    resourceId: memberId,
    details: { userId: target.userId },
  });

  return c.json({ ok: true });
});

// POST /api/team/transfer-ownership — hand ownership to another member (owner only).
teamRouter.post("/transfer-ownership", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  if (session.role !== "owner") {
    return c.json(
      { error: "Only the organization owner can transfer ownership" },
      403,
    );
  }

  const body = (await c.req.json().catch(() => null)) as {
    memberId?: unknown;
  } | null;
  if (
    !body ||
    typeof body.memberId !== "string" ||
    !ID_RE.test(body.memberId)
  ) {
    return c.json({ error: "memberId is required" }, 400);
  }

  const actorId = session.userId;
  const target = await c.env.DB.prepare(
    "SELECT id, userId, role FROM members WHERE id = ? AND organizationId = ?",
  )
    .bind(body.memberId, orgId)
    .first<{ id: string; userId: string; role: string }>();
  if (!target) return c.json({ error: "Member not found" }, 404);
  if (target.role === "owner") {
    return c.json({ error: "Member is already the owner" }, 409);
  }

  // Double-check the actor really is the current owner (defense in depth).
  const actor = await c.env.DB.prepare(
    "SELECT role FROM members WHERE userId = ? AND organizationId = ?",
  )
    .bind(actorId, orgId)
    .first<{ role: string }>();
  if (!actor || actor.role !== "owner") {
    return c.json(
      { error: "Only the organization owner can transfer ownership" },
      403,
    );
  }

  const from = await c.env.DB.prepare(
    "SELECT id FROM members WHERE userId = ? AND organizationId = ? AND role = 'owner'",
  )
    .bind(actorId, orgId)
    .first<{ id: string }>();
  if (!from) return c.json({ error: "Current owner not found" }, 409);

  // Atomically swap roles: new owner promoted, previous owner demoted to admin.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE members SET role = 'owner' WHERE id = ? AND organizationId = ?",
    ).bind(target.id, orgId),
    c.env.DB.prepare(
      "UPDATE members SET role = 'admin' WHERE id = ? AND organizationId = ?",
    ).bind(from.id, orgId),
  ]);

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "transfer_ownership",
    resourceType: "member",
    resourceId: target.id,
    details: { toUserId: target.userId },
  });

  return c.json({ ok: true });
});
