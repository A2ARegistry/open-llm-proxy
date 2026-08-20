import type { AppBindings } from "../app";
import {
  getTenantPrefixInfo,
  resolveTenantByPrefix,
} from "../tenants/prefixes";
import { createMiddleware } from "hono/factory";

/**
 * Resolve an optional leading tenant URL prefix (`/<prefix>/v1/...`) into the
 * owning organization. Runs before API-key auth; the prefix is stored on the
 * context so the post-auth guard can verify it matches the key's tenant.
 */
export const tenantPrefixMiddleware = createMiddleware<AppBindings>(
  async (c, next) => {
    const prefix = c.req.param("tenantPrefix");
    if (!prefix) {
      c.set("urlPrefixOrgId", null);
      return next();
    }
    const info = await resolveTenantByPrefix(c.env, prefix);
    if (!info) {
      return c.json(
        { error: { message: `Unknown tenant prefix "${prefix}"` } },
        404,
      );
    }
    c.set("urlPrefixOrgId", info.organizationId);
    return next();
  },
);

/**
 * Runs after apiKeyAuthMiddleware. The tenant is always the key's tenant; a
 * present prefix must belong to that same tenant. The root path (no prefix) is
 * reserved for the root tenant — other tenants must use their prefix.
 */
export const tenantPrefixGuardMiddleware = createMiddleware<AppBindings>(
  async (c, next) => {
    const keyOrg = c.get("apiKeyAuth")!.organizationId;
    const prefixOrg = c.get("urlPrefixOrgId");

    if (prefixOrg) {
      if (prefixOrg !== keyOrg) {
        return c.json(
          {
            error: {
              message: "Tenant prefix does not match the API key tenant",
            },
          },
          403,
        );
      }
      return next();
    }

    const org = await c.env.DB.prepare(
      `SELECT is_root_tenant, system_prefix, custom_prefix
       FROM organizations WHERE id = ?`,
    )
      .bind(keyOrg)
      .first<{
        is_root_tenant: number;
        system_prefix: string | null;
        custom_prefix: string | null;
      }>();
    if (org && org.is_root_tenant === 1) return next();

    const hint = org?.custom_prefix ?? org?.system_prefix;
    return c.json(
      {
        error: {
          message: hint
            ? `Use your tenant base URL: /${hint}/v1/chat/completions`
            : "Unknown tenant",
        },
      },
      404,
    );
  },
);

export async function resolveKeyTenantPrefix(
  c: import("hono").Context<AppBindings>,
): Promise<{ organizationId: string; basePath: string }> {
  const info = await getTenantPrefixInfo(
    c.env,
    c.get("apiKeyAuth")!.organizationId,
  );
  const basePath =
    info?.customPrefix ?? (info?.isRoot ? "" : (info?.systemPrefix ?? ""));
  return { organizationId: c.get("apiKeyAuth")!.organizationId, basePath };
}
