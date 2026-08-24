import { getAuthFor } from "../auth/setup";
import { AppBindings, SessionAuth } from "../types";
import { nowSeconds, safeJsonParse, sha256Hex } from "../utils/crypto";
import { getSessionToken } from "@contentgrowth/content-auth/backend";
import { createMiddleware } from "hono/factory";

const CACHE_TTL = 60;

async function loadFromCache(
  env: Env,
  token: string,
): Promise<SessionAuth | null> {
  const key = `session:${await sha256Hex(token)}`;
  const raw = await env.SESSION_CACHE.get(key);
  if (!raw) return null;
  const cached = safeJsonParse(raw, null) as SessionAuth | null;
  if (!cached) return null;
  if (cached.expiresAt < nowSeconds()) {
    await env.SESSION_CACHE.delete(key);
    return null;
  }
  return cached;
}

async function storeInCache(
  env: Env,
  token: string,
  value: SessionAuth,
): Promise<void> {
  const key = `session:${await sha256Hex(token)}`;
  await env.SESSION_CACHE.put(key, JSON.stringify(value), {
    expirationTtl: CACHE_TTL,
  });
}

export async function invalidateSessionCache(
  env: Env,
  token: string,
): Promise<void> {
  const key = `session:${await sha256Hex(token)}`;
  await env.SESSION_CACHE.delete(key);
}

/**
 * Session auth for dashboard/admin routes: KV read-through cache over
 * Better Auth sessions (D1 is the source of truth).
 */
export const sessionAuthMiddleware = createMiddleware<AppBindings>(
  async (c, next) => {
    const env = c.env;
    const token = getSessionToken(c.req.raw);
    if (!token) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const cached = await loadFromCache(env, token);
    if (cached) {
      c.set("session", cached);
      await next();
      return;
    }

    const auth = await getAuthFor(env, new URL(c.req.raw.url).origin);
    c.set("auth", auth);
    const result = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (!result?.session || !result?.user) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const session = result.session;
    const user = result.user;
    let organizationId: string | null = null;
    let role: string | null = null;

    const activeOrgId =
      (session as { activeOrganizationId?: string }).activeOrganizationId ??
      null;
    if (activeOrgId) {
      organizationId = activeOrgId;
      const member = await env.DB.prepare(
        "SELECT role FROM members WHERE organizationId = ? AND userId = ?",
      )
        .bind(activeOrgId, user.id)
        .first<{ role: string }>();
      role = member?.role ?? null;
    }

    // Fallback: if the session has no active org yet (e.g. right after
    // onboarding created the org), activate the user's first membership so
    // the dashboard and better-auth org endpoints just work.
    if (!organizationId || !role) {
      const first = await env.DB.prepare(
        "SELECT organizationId, role FROM members WHERE userId = ? ORDER BY createdAt ASC LIMIT 1",
      )
        .bind(user.id)
        .first<{ organizationId: string; role: string }>();
      if (first) {
        organizationId = first.organizationId;
        role = first.role;
        if (activeOrgId !== first.organizationId) {
          await env.DB.prepare(
            "UPDATE sessions SET activeOrganizationId = ? WHERE id = ? AND userId = ?",
          )
            .bind(first.organizationId, session.id, user.id)
            .run();
        }
      }
    }

    const sessionAuth: SessionAuth = {
      userId: user.id,
      sessionId: session.id,
      organizationId,
      role,
      email: user.email,
      expiresAt: Math.floor(new Date(session.expiresAt).getTime() / 1000),
    };
    c.set("session", sessionAuth);
    await storeInCache(env, token, sessionAuth);
    await next();
  },
);

/**
 * API-key auth for the programmatic Open LLM Proxy path.
 * The key is hashed (SHA-256) and looked up in `api_keys`.
 */
export const apiKeyAuthMiddleware = createMiddleware<AppBindings>(
  async (c, next) => {
    const env = c.env;
    const authHeader = c.req.header("authorization");
    const xApiKey = c.req.header("x-api-key");
    let key: string | null = null;
    if (authHeader?.startsWith("Bearer ")) {
      key = authHeader.slice(7).trim();
    } else if (xApiKey) {
      key = xApiKey.trim();
    }

    if (!key) {
      return c.json(
        {
          error:
            "Missing API key. Provide it via Authorization: Bearer <key> or x-api-key header.",
        },
        401,
      );
    }

    const keyHash = await sha256Hex(key);
    const row = await env.DB.prepare(
      `SELECT id, organization_id, name, key_prefix, status, expires_at, scopes, spend_disabled_until
       FROM api_keys WHERE key_hash = ?`,
    )
      .bind(keyHash)
      .first<{
        id: string;
        organization_id: string;
        name: string;
        key_prefix: string;
        status: string;
        expires_at: number | null;
        scopes: string;
        spend_disabled_until: number | null;
      }>();
    if (!row) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    if (row.status !== "active") {
      return c.json({ error: "API key is revoked" }, 403);
    }
    if (row.expires_at && row.expires_at < nowSeconds()) {
      return c.json({ error: "API key has expired" }, 403);
    }

    c.set("apiKeyAuth", {
      keyId: row.id,
      organizationId: row.organization_id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: safeJsonParse(row.scopes, {}),
      spendDisabledUntil: row.spend_disabled_until,
    });

    // Keep last_used_at fresh (throttled to once per minute to limit writes).
    const lastUsed = await env.DB.prepare(
      "SELECT last_used_at FROM api_keys WHERE id = ?",
    )
      .bind(row.id)
      .first<{ last_used_at: number | null }>();
    if (!lastUsed?.last_used_at || lastUsed.last_used_at < nowSeconds() - 60) {
      await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
        .bind(nowSeconds(), row.id)
        .run();
    }

    await next();
  },
);
