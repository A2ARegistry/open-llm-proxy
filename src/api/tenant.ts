import type { AppBindings } from "../app";
import { auditLog } from "../audit/audit-logger";
import { getTenantPrefixInfo, validateCustomPrefix } from "../tenants/prefixes";
import { Hono } from "hono";

export const tenantRouter = new Hono<AppBindings>();

// GET /api/tenant — current org's URL prefix info (system + custom + root flag).
tenantRouter.get("/", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const info = await getTenantPrefixInfo(c.env, orgId);
  if (!info) return c.json({ error: "Organization not found" }, 404);
  const basePath =
    info.customPrefix ?? (info.isRoot ? "" : (info.systemPrefix ?? ""));
  return c.json({
    organizationId: orgId,
    isRoot: info.isRoot,
    systemPrefix: info.systemPrefix,
    customPrefix: info.customPrefix,
    basePath,
  });
});

// PUT /api/tenant/prefix — set or clear the org's custom URL prefix.
// Only the root tenant may clear it (set null/""); everyone else must keep a
// non-empty prefix. Prefixes are validated + must be globally unique.
tenantRouter.put("/prefix", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;

  const body = (await c.req.json().catch(() => null)) as {
    customPrefix?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const raw = body.customPrefix;
  let value: string | null;
  if (raw === null || raw === undefined) {
    value = null;
  } else if (typeof raw === "string") {
    value = raw.trim();
  } else {
    return c.json({ error: "customPrefix must be a string or null" }, 400);
  }

  const info = await getTenantPrefixInfo(c.env, orgId);
  if (!info) return c.json({ error: "Organization not found" }, 404);

  if (!value) {
    if (!info.isRoot) {
      return c.json(
        {
          error:
            "Only the root tenant may use an empty URL prefix. Other tenants must keep a non-empty prefix.",
        },
        400,
      );
    }
    await c.env.DB.prepare(
      "UPDATE organizations SET custom_prefix = NULL WHERE id = ?",
    )
      .bind(orgId)
      .run();
    await auditLog(c.env, {
      organizationId: orgId,
      userId: session.userId,
      action: "update",
      resourceType: "tenant",
      resourceId: orgId,
      details: { prefix: null },
    });
    return c.json({ ok: true, customPrefix: null });
  }

  const invalid = validateCustomPrefix(value);
  if (invalid) return c.json({ error: invalid }, 400);

  const taken = await c.env.DB.prepare(
    `SELECT id FROM organizations
     WHERE (custom_prefix = ? OR system_prefix = ?) AND id != ?`,
  )
    .bind(value, value, orgId)
    .first<{ id: string }>();
  if (taken) {
    return c.json({ error: `Prefix "${value}" is already taken` }, 409);
  }

  await c.env.DB.prepare(
    "UPDATE organizations SET custom_prefix = ? WHERE id = ?",
  )
    .bind(value, orgId)
    .run();
  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "update",
    resourceType: "tenant",
    resourceId: orgId,
    details: { prefix: value },
  });
  return c.json({ ok: true, customPrefix: value });
});
