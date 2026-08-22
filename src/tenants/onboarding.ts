import { auditLog } from "../audit/audit-logger";
import { newId, nowSeconds } from "../utils/crypto";
import { assignTenantPrefixes } from "./prefixes";

export interface SignupUser {
  id: string;
  name?: string;
  email: string;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "org"
  );
}

/**
 * Create a default organization for a newly signed-up user and make them owner.
 * Runs inside the content-auth `onSignup` hook.
 */
export async function handleSignup(env: Env, user: SignupUser): Promise<void> {
  const orgId = newId("org");
  const orgName = `${user.name || user.email.split("@")[0]}'s Organization`;
  const slug = `${slugify(orgName)}-${orgId.slice(-6)}`;
  const now = nowSeconds();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organizations (id, name, slug, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(orgId, orgName, slug, now, now),
    env.DB.prepare(
      `INSERT INTO members (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(newId("mem"), orgId, user.id, now),
  ]);

  await assignTenantPrefixes(env, orgId);

  await auditLog(env, {
    organizationId: orgId,
    userId: user.id,
    action: "create",
    resourceType: "tenant",
    resourceId: orgId,
    details: { name: orgName },
  });
}

/** Create a membership row for a user in an org (used by team management). */
export async function addMember(
  env: Env,
  organizationId: string,
  userId: string,
  role: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO members (id, organizationId, userId, role, createdAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(organizationId, userId) DO UPDATE SET role = excluded.role`,
  )
    .bind(newId("mem"), organizationId, userId, role, nowSeconds())
    .run();
}
