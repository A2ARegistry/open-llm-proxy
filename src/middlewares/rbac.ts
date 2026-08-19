import type { AppBindings } from "../app";
import { createMiddleware } from "hono/factory";

const ADMIN_ROLES = ["owner", "admin"] as const;
const MEMBER_ROLES = [...ADMIN_ROLES, "member"] as const;

export type RbacRole = (typeof MEMBER_ROLES)[number] | "viewer";

/** Requires a session with an active organization membership. */
export const requireOrgMember = createMiddleware<AppBindings>(
  async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Not authenticated" }, 401);
    if (!session.organizationId) {
      return c.json(
        { error: "No active organization. Create or join one." },
        403,
      );
    }
    if (session.role === "viewer") {
      return c.json({ error: "Viewer role cannot access this resource" }, 403);
    }
    await next();
  },
);

/** Requires the session user to hold one of the given roles in the org. */
export function requireRole(...roles: RbacRole[]) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "Not authenticated" }, 401);
    if (!session.organizationId) {
      return c.json(
        { error: "No active organization. Create or join one." },
        403,
      );
    }
    if (!roles.includes(session.role as RbacRole)) {
      return c.json(
        {
          error: `Requires role: ${roles.join(" or ")} (current: ${session.role ?? "none"})`,
        },
        403,
      );
    }
    await next();
  });
}

/** Requires owner/admin — mutating control-plane actions. */
export function requireAdmin() {
  return requireRole("owner", "admin");
}

export { ADMIN_ROLES, MEMBER_ROLES };
