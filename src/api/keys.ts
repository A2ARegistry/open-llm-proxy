import type { AppBindings } from "../app";
import { auditLog } from "../audit/audit-logger";
import {
  canonicalProviderName,
  isCustomProviderName,
  isKnownProviderName,
} from "../llm/provider-registry";
import { reconcileKeyDisable } from "../metrics/spend-guard";
import { newId } from "../tenants/encryption";
import { getTenantPrefixInfo } from "../tenants/prefixes";
import { ApiKeyScopes } from "../types";
import { effectiveBaseUrl } from "../utils/base-url";
import { randomBytes, sha256Hex, nowSeconds } from "../utils/crypto";
import { Hono } from "hono";

const KEY_PREFIX = "sk_live_";
const ID_RE = /^[a-z0-9_]{1,64}$/i;

function generateApiKey(): string {
  return `${KEY_PREFIX}${Array.from(randomBytes(32), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function validateScopes(scopes: unknown): ApiKeyScopes {
  if (scopes === undefined) return {};
  if (typeof scopes !== "object" || scopes === null || Array.isArray(scopes)) {
    throw new Error("scopes must be an object");
  }
  const out: ApiKeyScopes = {};
  const input = scopes as Record<string, unknown>;
  if (input.providers !== undefined) {
    if (
      !Array.isArray(input.providers) ||
      input.providers.some((p) => typeof p !== "string")
    ) {
      throw new Error("scopes.providers must be an array of strings");
    }
    out.providers = input.providers as string[];
  }
  if (input.models !== undefined) {
    if (
      !Array.isArray(input.models) ||
      input.models.some((m) => typeof m !== "string")
    ) {
      throw new Error("scopes.models must be an array of strings");
    }
    out.models = input.models as string[];
  }
  if (input.spendCapUsd !== undefined) {
    if (typeof input.spendCapUsd !== "number" || input.spendCapUsd < 0) {
      throw new Error("scopes.spendCapUsd must be a non-negative number");
    }
    out.spendCapUsd = input.spendCapUsd;
  }
  if (input.ipAllowlist !== undefined) {
    if (
      !Array.isArray(input.ipAllowlist) ||
      input.ipAllowlist.some((ip) => typeof ip !== "string")
    ) {
      throw new Error("scopes.ipAllowlist must be an array of strings");
    }
    out.ipAllowlist = input.ipAllowlist as string[];
  }
  if (input.defaultProvider !== undefined) {
    if (
      typeof input.defaultProvider !== "string" ||
      (!isKnownProviderName(input.defaultProvider) &&
        !isCustomProviderName(input.defaultProvider))
    ) {
      throw new Error(
        "scopes.defaultProvider must be a known provider id or a custom provider id",
      );
    }
    out.defaultProvider = canonicalProviderName(input.defaultProvider);
  }
  return out;
}

function publicKeyView(
  row: {
    id: string;
    name: string;
    key_prefix: string;
    status: string;
    scopes: string;
    created_at: number;
    expires_at: number | null;
    last_used_at: number | null;
    created_by: string;
  },
  endpoint?: string,
) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    status: row.status,
    scopes: JSON.parse(row.scopes || "{}") as ApiKeyScopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdBy: row.created_by,
    ...(endpoint ? { endpoint } : {}),
  };
}

export const keysRouter = new Hono<AppBindings>();

type KeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  status: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  created_by: string;
};

// GET /api/keys — list tenant keys (full key stored/hidden server-side).
keysRouter.get("/", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, key_prefix, status, scopes, created_at, expires_at, last_used_at, created_by
     FROM api_keys WHERE organization_id = ? ORDER BY created_at DESC`,
  )
    .bind(orgId)
    .all<KeyRow>();

  // Get tenant prefix info to build base endpoint URL
  const prefixInfo = await getTenantPrefixInfo(c.env, orgId);
  const basePath = prefixInfo
    ? (prefixInfo.customPrefix ??
      (prefixInfo.isRoot ? "" : (prefixInfo.systemPrefix ?? "")))
    : "";
  const baseUrl = effectiveBaseUrl(c.env.BASE_URL, c.req.raw.url);
  const endpoint = basePath ? `${baseUrl}/${basePath}` : baseUrl;

  return c.json({ keys: results.map((r) => publicKeyView(r, endpoint)) });
});

// POST /api/keys — create a key; returns the plaintext key exactly once.
keysRouter.post("/", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;

  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    scopes?: unknown;
    expiresAt?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const name = body.name ?? "default";
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > 128
  ) {
    return c.json(
      { error: "name must be a non-empty string (max 128 chars)" },
      400,
    );
  }

  let scopes: ApiKeyScopes;
  try {
    scopes = validateScopes(body.scopes);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  let expiresAt: number | null = null;
  if (body.expiresAt !== undefined) {
    if (typeof body.expiresAt !== "number" || Number.isNaN(body.expiresAt)) {
      return c.json(
        { error: "expiresAt must be a unix timestamp (seconds)" },
        400,
      );
    }
    expiresAt = body.expiresAt;
  }

  const plaintext = generateApiKey();
  const keyHash = await sha256Hex(plaintext);
  const id = newId("key");
  const now = nowSeconds();

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, organization_id, name, key_hash, key_prefix, created_by, created_at, expires_at, status, scopes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  )
    .bind(
      id,
      orgId,
      name.trim(),
      keyHash,
      plaintext.slice(0, 8),
      session.userId,
      now,
      expiresAt,
      JSON.stringify(scopes),
    )
    .run();

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "create",
    resourceType: "api_key",
    resourceId: id,
    details: { name: name.trim(), keyPrefix: plaintext.slice(0, 8) },
  });

  // Get tenant prefix info to build base endpoint URL
  const prefixInfo = await getTenantPrefixInfo(c.env, orgId);
  const basePath = prefixInfo
    ? (prefixInfo.customPrefix ??
      (prefixInfo.isRoot ? "" : (prefixInfo.systemPrefix ?? "")))
    : "";
  const baseUrl = effectiveBaseUrl(c.env.BASE_URL, c.req.raw.url);
  const endpoint = basePath ? `${baseUrl}/${basePath}` : baseUrl;

  return c.json(
    {
      id,
      name: name.trim(),
      key: plaintext,
      keyPrefix: plaintext.slice(0, 8),
      status: "active",
      scopes,
      expiresAt,
      createdAt: now,
      endpoint,
    },
    201,
  );
});

// PATCH /api/keys/:id — update name/status/scopes/expiry.
keysRouter.patch("/:id", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Invalid key id" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT id FROM api_keys WHERE id = ? AND organization_id = ?",
  )
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: "API key not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    status?: unknown;
    scopes?: unknown;
    expiresAt?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  let scopeUpdate: ApiKeyScopes | undefined;

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    sets.push("name = ?");
    params.push(body.name.trim());
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "revoked") {
      return c.json({ error: "status must be 'active' or 'revoked'" }, 400);
    }
    sets.push("status = ?");
    params.push(body.status);
  }
  if (body.scopes !== undefined) {
    let scopes: ApiKeyScopes;
    try {
      scopes = validateScopes(body.scopes);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    sets.push("scopes = ?");
    params.push(JSON.stringify(scopes));
    scopeUpdate = scopes;
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt !== null && typeof body.expiresAt !== "number") {
      return c.json(
        { error: "expiresAt must be a unix timestamp or null" },
        400,
      );
    }
    sets.push("expires_at = ?");
    params.push(body.expiresAt);
  }

  if (sets.length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  params.push(id, orgId);
  await c.env.DB.prepare(
    `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`,
  )
    .bind(...params)
    .run();

  if (scopeUpdate) {
    await reconcileKeyDisable(c.env, orgId, id, scopeUpdate.spendCapUsd);
  }

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "update",
    resourceType: "api_key",
    resourceId: id,
    details: { updated: sets.map((s) => s.split(" ")[0]) },
  });

  const row = await c.env.DB.prepare(
    `SELECT id, name, key_prefix, status, scopes, created_at, expires_at, last_used_at, created_by
     FROM api_keys WHERE id = ? AND organization_id = ?`,
  )
    .bind(id, orgId)
    .first<KeyRow>();
  return c.json({ key: row ? publicKeyView(row) : null });
});

// POST /api/keys/:id/rotate — new secret under the same key id; old one dies.
keysRouter.post("/:id/rotate", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Invalid key id" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT id, organization_id FROM api_keys WHERE id = ? AND organization_id = ?",
  )
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: "API key not found" }, 404);

  const plaintext = generateApiKey();
  const keyHash = await sha256Hex(plaintext);

  await c.env.DB.prepare(
    `UPDATE api_keys SET key_hash = ?, key_prefix = ?, status = 'active'
     WHERE id = ?`,
  )
    .bind(keyHash, plaintext.slice(0, 8), id)
    .run();

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "create",
    resourceType: "api_key",
    resourceId: id,
    details: { rotated: true },
  });

  // Get tenant prefix info to build base endpoint URL
  const prefixInfo = await getTenantPrefixInfo(c.env, orgId);
  const basePath = prefixInfo
    ? (prefixInfo.customPrefix ??
      (prefixInfo.isRoot ? "" : (prefixInfo.systemPrefix ?? "")))
    : "";
  const baseUrl = effectiveBaseUrl(c.env.BASE_URL, c.req.raw.url);
  const endpoint = basePath ? `${baseUrl}/${basePath}` : baseUrl;

  return c.json({
    id,
    key: plaintext,
    keyPrefix: plaintext.slice(0, 8),
    endpoint,
    message: "Previous key secret is revoked; update clients promptly.",
  });
});

// DELETE /api/keys/:id — revoke the key (soft delete; keeps metrics/audit intact).
keysRouter.delete("/:id", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.json({ error: "Invalid key id" }, 400);

  const result = await c.env.DB.prepare(
    "UPDATE api_keys SET status = 'revoked' WHERE id = ? AND organization_id = ?",
  )
    .bind(id, orgId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return c.json({ error: "API key not found" }, 404);
  }

  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "delete",
    resourceType: "api_key",
    resourceId: id,
    details: { revoked: true },
  });

  return c.json({ ok: true });
});
