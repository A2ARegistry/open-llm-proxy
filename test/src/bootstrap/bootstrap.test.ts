import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ensureBootstrapped, bootstrapStatus } from "~/src/bootstrap";
import {
  ensureInitialAdmin,
  getInitialAdmin,
  hashPassword,
  verifyPassword,
  rotateInitialAdminPassword,
} from "~/src/bootstrap/admin";
import { getAuthSecret, getEncryptionKey } from "~/src/bootstrap/secrets";
import { getSetting } from "~/src/db/settings";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, activeOrganizationId TEXT);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER, metadata TEXT);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT, status TEXT NOT NULL, expiresAt INTEGER NOT NULL, inviterId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details TEXT, timestamp INTEGER NOT NULL DEFAULT 0);
`;

async function resetDb() {
  for (const table of [
    "audit_logs",
    "invitations",
    "members",
    "accounts",
    "sessions",
    "verifications",
    "organizations",
    "users",
    "system_settings",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
}

beforeAll(async () => {
  for (const stmt of SCHEMA.split(";")) {
    if (stmt.trim()) await env.DB.exec(stmt);
  }
});

beforeEach(async () => {
  await resetDb();
});

describe("bootstrap secrets", () => {
  it("generates, persists, and re-reads auth secret + encryption key", async () => {
    await ensureBootstrapped(env);
    const secret = await getAuthSecret(env);
    expect(secret).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(await getSetting(env, "app.better_auth_secret")).toBe(secret);
    expect(secret).toBe(await getAuthSecret(env));

    const key = await getEncryptionKey(env);
    expect(await getSetting(env, "app.encryption_key")).toBe(key);
    expect(key).toBe(await getEncryptionKey(env));
  });
});

describe("bootstrap admin", () => {
  it("seeds the default admin + owner org on a fresh DB", async () => {
    expect(await ensureInitialAdmin(env)).toBe(true);

    const admin = await getInitialAdmin(env);
    expect(admin?.email).toBe("admin@example.com");
    expect(admin?.mustChangePassword).toBe(true);

    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(admin!.userId)
      .first<{ email: string; emailVerified: number }>();
    expect(user?.email).toBe("admin@example.com");
    expect(user?.emailVerified).toBe(1);

    const member = await env.DB.prepare(
      "SELECT role FROM members WHERE userId = ? AND organizationId = ?",
    )
      .bind(admin!.userId, admin!.organizationId)
      .first<{ role: string }>();
    expect(member?.role).toBe("owner");
  });

  it("is idempotent", async () => {
    expect(await ensureInitialAdmin(env)).toBe(true);
    expect(await ensureInitialAdmin(env)).toBe(false);
    expect(await ensureInitialAdmin(env)).toBe(false);
  });

  it("reports status + default credentials while must-change is set", async () => {
    await ensureInitialAdmin(env);
    const status = await bootstrapStatus(env);
    expect(status.initialized).toBe(true);
    expect(status.defaultCredentials?.email).toBe("admin@example.com");
    expect(status.defaultCredentials?.password).toBe("AwesomeProxy!!");
  });

  it("verifies the seeded password hash", async () => {
    await ensureInitialAdmin(env);
    const admin = await getInitialAdmin(env);
    const account = await env.DB.prepare(
      "SELECT password FROM accounts WHERE userId = ? AND providerId = 'credential'",
    )
      .bind(admin!.userId)
      .first<{ password: string }>();
    expect(await verifyPassword("AwesomeProxy!!", account!.password)).toBe(
      true,
    );
    expect(await verifyPassword("wrong-password", account!.password)).toBe(
      false,
    );
  });
});

describe("rotateInitialAdminPassword", () => {
  it("rejects a wrong current password", async () => {
    await ensureInitialAdmin(env);
    const admin = await getInitialAdmin(env);
    await expect(
      rotateInitialAdminPassword(
        env,
        admin!.userId,
        admin!.organizationId,
        "nope",
        "ABcdef123456!!",
      ),
    ).rejects.toThrow("Current password is incorrect");
  });

  it("rejects non-admin sessions", async () => {
    await expect(
      rotateInitialAdminPassword(
        env,
        "user_other",
        null,
        "AwesomeProxy!!",
        "ABcdef123456!!",
      ),
    ).rejects.toThrow("Not the initial admin account");
  });

  it("rotates the password and clears the flag", async () => {
    await ensureInitialAdmin(env);
    const admin = await getInitialAdmin(env);

    await rotateInitialAdminPassword(
      env,
      admin!.userId,
      admin!.organizationId,
      "AwesomeProxy!!",
      "NewStr0ngPass!!",
    );

    expect((await getInitialAdmin(env))?.mustChangePassword).toBe(false);
    const status = await bootstrapStatus(env);
    expect(status.defaultCredentials).toBeUndefined();

    const account = await env.DB.prepare(
      "SELECT password FROM accounts WHERE userId = ? AND providerId = 'credential'",
    )
      .bind(admin!.userId)
      .first<{ password: string }>();
    expect(await verifyPassword("NewStr0ngPass!!", account!.password)).toBe(
      true,
    );
    expect(await verifyPassword("AwesomeProxy!!", account!.password)).toBe(
      false,
    );
  });
});

describe("password hashing helpers", () => {
  it("produces content-auth pbkdf2 format and verifies", async () => {
    const hash = await hashPassword("s3cret!!word");
    expect(hash).toMatch(/^pbkdf2:100000:/);
    expect(await verifyPassword("s3cret!!word", hash)).toBe(true);
    expect(await verifyPassword("other!", hash)).toBe(false);
    expect(await verifyPassword("x", "argon2:junk")).toBe(false);
  });
});
