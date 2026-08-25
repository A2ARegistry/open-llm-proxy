import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, it, expect, beforeAll } from "vitest";
import { keysRouter } from "~/src/api/keys";
import type { AppBindings } from "~/src/app";
import type { SessionAuth } from "~/src/types";

const session: SessionAuth = {
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: "org_1",
  role: "admin",
  email: "admin@acme.test",
  expiresAt: 9999999999,
};

function buildApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use("*", (c, next) => {
    c.set("session", session);
    return next();
  });
  app.route("/api/keys", keysRouter);
  return app;
}

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, is_root_tenant INTEGER NOT NULL DEFAULT 0, system_prefix TEXT, custom_prefix TEXT);",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active', scopes TEXT NOT NULL DEFAULT '{}');",
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, organization_id TEXT, user_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, timestamp INTEGER NOT NULL);",
  );
});

const RESPONSE = "response";

async function fetchJson(
  app: Hono<AppBindings>,
  path: string,
  init?: RequestInit,
) {
  const res = await app.request(path, init, env as never);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body, [RESPONSE]: res };
}

describe("GET /api/keys", () => {
  it("returns an empty list and never exposes key material", async () => {
    const app = buildApp();
    const { status, body } = await fetchJson(app, "/api/keys");
    expect(status).toBe(200);
    expect(body).toEqual({ keys: [] });
  });
});

describe("POST /api/keys", () => {
  it("creates a key and returns plaintext exactly once", async () => {
    const app = buildApp();
    const { status, body } = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "prod-key" }),
    });
    expect(status).toBe(201);
    expect(body.key).toMatch(/^sk_live_[0-9a-f]{64}$/);
    expect(body.keyPrefix).toBe(body.key.slice(0, 8));
    expect(body.status).toBe("active");

    const row = await env.DB.prepare(
      "SELECT key_hash, name, key_prefix FROM api_keys WHERE id = ?",
    )
      .bind(body.id)
      .first<{ key_hash: string; name: string; key_prefix: string }>();
    expect(row).not.toBeNull();
    expect(row!.name).toBe("prod-key");
    expect(row!.key_hash).not.toBe(body.key);
    expect(row!.key_prefix).toBe(body.key.slice(0, 8));
  });

  it("stores scopes and expiry", async () => {
    const app = buildApp();
    const { status, body } = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "scoped",
        expiresAt: 9999999999,
        scopes: {
          providers: ["openai"],
          models: ["gpt-4o"],
          spendCapUsd: 25,
          defaultProvider: "google",
        },
      }),
    });
    expect(status).toBe(201);
    expect(body.scopes.providers).toEqual(["openai"]);
    expect(body.scopes.defaultProvider).toBe("google-ai-studio");
    expect(body.expiresAt).toBe(9999999999);
  });

  it("rejects an unknown scopes.defaultProvider", async () => {
    const app = buildApp();
    const { status } = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "scoped",
        scopes: { defaultProvider: "No-Such" },
      }),
    });
    expect(status).toBe(400);
  });

  it.each([
    [JSON.stringify({ name: 42 }), "non-string name"],
    [
      JSON.stringify({ scopes: { providers: "openai" } }),
      "bad providers scope",
    ],
    [JSON.stringify({ scopes: { spendCapUsd: -5 } }), "negative spendCapUsd"],
    [JSON.stringify({ expiresAt: "soon" }), "bad expiresAt"],
    ["not-json", "invalid JSON"],
  ])("rejects a request with %s", async (payload) => {
    const app = buildApp();
    const { status } = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(status).toBe(400);
  });
});

describe("GET /api/keys/:id", () => {
  it("lists keys with masked prefix only", async () => {
    const app = buildApp();
    await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "mask-me" }),
    });
    const { status, body } = await fetchJson(app, "/api/keys");
    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("key_hash");
    expect(serialized).toMatch(/sk_live_/);
    expect(body.keys[0].keyPrefix).toBe(body.keys[0].keyPrefix.slice(0, 8));
  });
});

describe("PATCH /api/keys/:id", () => {
  it("updates name and status", async () => {
    const app = buildApp();
    const created = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "before" }),
    });
    const patched = await fetchJson(app, `/api/keys/${created.body.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "after", status: "revoked" }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.key.name).toBe("after");
    expect(patched.body.key.status).toBe("revoked");
  });

  it("rejects an invalid status", async () => {
    const app = buildApp();
    const created = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    const res = await fetchJson(app, `/api/keys/${created.body.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown key", async () => {
    const app = buildApp();
    const res = await fetchJson(app, "/api/keys/key_nope_000", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/keys/:id/rotate", () => {
  it("rotates the secret under the same id", async () => {
    const app = buildApp();
    const created = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "rotater" }),
    });
    const oldSecret = created.body.key;

    const rotated = await fetchJson(
      app,
      `/api/keys/${created.body.id}/rotate`,
      {
        method: "POST",
      },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.key).not.toBe(oldSecret);

    const row = await env.DB.prepare(
      "SELECT key_hash, key_prefix FROM api_keys WHERE id = ?",
    )
      .bind(created.body.id)
      .first<{ key_hash: string; key_prefix: string }>();
    expect(row!.key_hash).not.toBe(oldSecret);
    expect(row!.key_prefix).toBe(rotated.body.key.slice(0, 8));
  });

  it("returns 404 for an unknown key", async () => {
    const app = buildApp();
    const res = await fetchJson(app, "/api/keys/key_nope_000/rotate", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/keys/:id", () => {
  it("revokes the key (soft delete)", async () => {
    const app = buildApp();
    const created = await fetchJson(app, "/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "revocable" }),
    });
    const res = await fetchJson(app, `/api/keys/${created.body.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT status FROM api_keys WHERE id = ?")
      .bind(created.body.id)
      .first<{ status: string }>();
    expect(row!.status).toBe("revoked");
  });

  it("returns 404 for an unknown key", async () => {
    const app = buildApp();
    const res = await fetchJson(app, "/api/keys/key_nope_000", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
