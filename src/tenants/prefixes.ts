import { getOrCreateSetting } from "../db/settings";
import { randomBytes } from "../utils/crypto";

/** system_settings key holding the org id that owns the empty (root) path. */
export const ROOT_TENANT_SETTING = "root_tenant_org_id";
export const SYSTEM_PREFIX_PREFIX = "proxy_";
export const MIN_CUSTOM_PREFIX_LENGTH = 6;

/** Words that collide with public/admin route segments — never usable as a prefix. */
export const RESERVED_PREFIX_WORDS = new Set([
  "v1",
  "v2",
  "api",
  "auth",
  "models",
  "chat",
  "completions",
  "admin",
  "dashboard",
  "bootstrap",
  "email",
  "team",
  "usage",
  "metrics",
  "alerts",
  "providers",
  "keys",
  "settings",
  "org",
  "health",
]);

const CUSTOM_PREFIX_RE = /^[a-z0-9-]+$/;

export interface TenantPrefixInfo {
  organizationId: string;
  isRoot: boolean;
  systemPrefix: string | null;
  customPrefix: string | null;
}

/** Random `proxy_<6 alnum>` system prefix (uniqueness enforced by the caller). */
export function generateSystemPrefix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (const b of randomBytes(6)) out += alphabet[b % alphabet.length];
  return `${SYSTEM_PREFIX_PREFIX}${out}`;
}

/** Returns an error message when the custom prefix is invalid, else null. */
export function validateCustomPrefix(prefix: string): string | null {
  if (prefix.length < MIN_CUSTOM_PREFIX_LENGTH) {
    return `Custom prefix must be at least ${MIN_CUSTOM_PREFIX_LENGTH} characters`;
  }
  if (!CUSTOM_PREFIX_RE.test(prefix)) {
    return "Custom prefix may only contain lowercase letters, digits and dashes";
  }
  if (prefix.startsWith(SYSTEM_PREFIX_PREFIX)) {
    return `The ${SYSTEM_PREFIX_PREFIX} prefix is reserved for system-assigned prefixes`;
  }
  if (RESERVED_PREFIX_WORDS.has(prefix)) {
    return `"${prefix}" is reserved and cannot be used as a tenant prefix`;
  }
  return null;
}

export async function getTenantPrefixInfo(
  env: Env,
  orgId: string,
): Promise<TenantPrefixInfo | null> {
  const row = await env.DB.prepare(
    `SELECT id, is_root_tenant, system_prefix, custom_prefix
     FROM organizations WHERE id = ?`,
  )
    .bind(orgId)
    .first<{
      id: string;
      is_root_tenant: number;
      system_prefix: string | null;
      custom_prefix: string | null;
    }>();
  if (!row) return null;
  return {
    organizationId: row.id,
    isRoot: row.is_root_tenant === 1,
    systemPrefix: row.system_prefix ?? null,
    customPrefix: row.custom_prefix ?? null,
  };
}

/** Resolve an org by its custom prefix first, then the system prefix. */
export async function resolveTenantByPrefix(
  env: Env,
  prefix: string,
): Promise<TenantPrefixInfo | null> {
  const row = await env.DB.prepare(
    `SELECT id, is_root_tenant, system_prefix, custom_prefix
     FROM organizations
     WHERE custom_prefix = ? OR system_prefix = ?
     LIMIT 1`,
  )
    .bind(prefix, prefix)
    .first<{
      id: string;
      is_root_tenant: number;
      system_prefix: string | null;
      custom_prefix: string | null;
    }>();
  if (!row) return null;
  return {
    organizationId: row.id,
    isRoot: row.is_root_tenant === 1,
    systemPrefix: row.system_prefix ?? null,
    customPrefix: row.custom_prefix ?? null,
  };
}

/** Assign `system_prefix` + root flag at org creation time. */
export async function assignTenantPrefixes(
  env: Env,
  orgId: string,
): Promise<void> {
  // The very first org (claimed atomically via system_settings) owns the root
  // path; every later org gets a unique `proxy_<6>` system prefix.
  const rootOrgId = await getOrCreateSetting(
    env,
    ROOT_TENANT_SETTING,
    () => orgId,
  );
  if (rootOrgId === orgId) {
    await env.DB.prepare(
      "UPDATE organizations SET is_root_tenant = 1 WHERE id = ?",
    )
      .bind(orgId)
      .run();
    return;
  }
  for (let i = 0; i < 20; i++) {
    const candidate = generateSystemPrefix();
    const dup = await env.DB.prepare(
      "SELECT id FROM organizations WHERE system_prefix = ?",
    )
      .bind(candidate)
      .first<{ id: string }>();
    if (!dup) {
      await env.DB.prepare(
        "UPDATE organizations SET system_prefix = ? WHERE id = ?",
      )
        .bind(candidate, orgId)
        .run();
      return;
    }
  }
  throw new Error("Could not allocate a unique tenant URL prefix");
}
