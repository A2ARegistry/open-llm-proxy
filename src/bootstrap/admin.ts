import { Env } from "../../worker-configuration.d";
import { auditLog } from "../audit/audit-logger";
import { setSetting } from "../db/settings";
import {
  fromBase64,
  newId,
  nowSeconds,
  pbkdf2Sha256,
  randomBytes,
  toBase64,
} from "../utils/crypto";

/**
 * PBKDF2-SHA256 password hashing in the content-auth format:
 * `pbkdf2:<iterations>:<salt b64>:<hash b64>`.
 */

const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2Sha256(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toBase64(salt)}:${toBase64(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [alg, iterationsStr, saltB64, hashB64] = stored.split(":");
  if (alg !== "pbkdf2" || !iterationsStr || !saltB64 || !hashB64) return false;
  const hash = await pbkdf2Sha256(
    password,
    fromBase64(saltB64),
    parseInt(iterationsStr, 10),
  );
  const expected = fromBase64(hashB64);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}

export const DEFAULT_ADMIN_EMAIL = "admin@localhost";
export const DEFAULT_ADMIN_PASSWORD = "AwesomeProxy!!";

export const INITIAL_ADMIN_SETTING = "app.initial_admin";
export const MUST_CHANGE_PASSWORD_SETTING =
  "app.initial_admin_must_change_password";

export interface InitialAdminInfo {
  email: string;
  userId: string;
  organizationId: string;
  mustChangePassword: boolean;
}

/**
 * Seed a default owner account on a fresh database so the deployment is usable
 * immediately: `admin@localhost` / `AwesomeProxy!!` (overridable via
 * `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` env vars). The account is
 * pre-verified (no email round-trip) and flagged as must-change-password.
 *
 * Idempotent: skips entirely once any user exists. Safe under concurrent
 * first requests via the UNIQUE(email) constraint.
 */
export async function ensureInitialAdmin(env: Env): Promise<boolean> {
  const existing = await env.DB.prepare("SELECT id FROM users LIMIT 1").first();
  if (existing) return false;

  const email = env.INITIAL_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL;
  const password = env.INITIAL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const userId = newId("usr");
  const organizationId = newId("org");
  const now = nowSeconds();
  const passwordHash = await hashPassword(password);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, "Administrator", email, now, now),
    env.DB.prepare(
      `INSERT INTO accounts (id, accountId, providerId, userId, password, createdAt, updatedAt)
       VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
    ).bind(newId("acc"), userId, userId, passwordHash, now, now),
    env.DB.prepare(
      `INSERT INTO organizations (id, name, slug, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      organizationId,
      "Default Organization",
      "default-organization",
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO members (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).bind(newId("mem"), organizationId, userId, now),
  ]);

  await Promise.all([
    setSetting(
      env,
      INITIAL_ADMIN_SETTING,
      JSON.stringify({ email, userId, organizationId }),
    ),
    setSetting(env, MUST_CHANGE_PASSWORD_SETTING, "1"),
  ]);

  await auditLog(env, {
    organizationId,
    userId,
    action: "create",
    resourceType: "tenant",
    resourceId: organizationId,
    details: { name: "Default Organization", bootstrap: true },
  });

  return true;
}

/** Read back the seeded admin info (if any). */
export async function getInitialAdmin(
  env: Env,
): Promise<InitialAdminInfo | undefined> {
  const raw = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = ?",
  )
    .bind(INITIAL_ADMIN_SETTING)
    .first<{ value: string | null }>();
  if (!raw?.value) return undefined;
  const parsed = JSON.parse(raw.value) as {
    email: string;
    userId: string;
    organizationId: string;
  };
  const mustChange =
    (
      await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
        .bind(MUST_CHANGE_PASSWORD_SETTING)
        .first<{ value: string | null }>()
    )?.value === "1";
  return { ...parsed, mustChangePassword: mustChange };
}

/** Clear the must-change-password flag after a successful password rotation. */
export async function clearMustChangePassword(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM system_settings WHERE key = ?`)
    .bind(MUST_CHANGE_PASSWORD_SETTING)
    .run();
}

/**
 * Rotate the seeded admin's credential password, verifying the current one
 * first. Only the initial admin account may call this. Clears the
 * must-change-password flag on success.
 */
export async function rotateInitialAdminPassword(
  env: Env,
  userId: string,
  organizationId: string | null,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const admin = await getInitialAdmin(env);
  if (!admin || admin.userId !== userId) {
    throw new Error("Not the initial admin account");
  }
  const account = await env.DB.prepare(
    `SELECT id, password FROM accounts
     WHERE userId = ? AND providerId = 'credential'`,
  )
    .bind(userId)
    .first<{ id: string; password: string }>();
  if (!account) {
    throw new Error("No password account found");
  }
  if (!(await verifyPassword(currentPassword, account.password))) {
    throw new Error("Current password is incorrect");
  }
  await env.DB.prepare(`UPDATE accounts SET password = ? WHERE id = ?`)
    .bind(await hashPassword(newPassword), account.id)
    .run();
  await clearMustChangePassword(env);
  await auditLog(env, {
    organizationId,
    userId,
    action: "update",
    resourceType: "credentials",
    details: { event: "bootstrap_password_changed" },
  });
}
