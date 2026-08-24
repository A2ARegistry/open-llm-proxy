import { getEncryptionKey } from "../bootstrap/secrets";
import { D1TenantKeyStore } from "../db/tenant";
import {
  EncryptedCredential,
  decryptCredential,
  deriveKek,
  encryptCredential,
  resolveTenantDek,
  createEncryptionAad,
  TenantKeys,
} from "../tenants/encryption";
import { newId } from "../tenants/encryption";
import { safeJsonParse, newUuid, nowSeconds } from "../utils/crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

export interface ProviderConfigRow {
  id: string;
  organization_id: string;
  provider: string;
  name: string;
  enabled: number;
  config: string;
}

export interface ProviderSettings {
  rotationStrategy?: "round-robin" | "first" | "random";
  timeout?: number;
  baseUrl?: string;
  chatCompletionPath?: string;
  modelsPath?: string;
  /**
   * Diagnostic Tracing: When enabled, logs full raw/converted request and
   * response payloads for bug investigations. Should be enabled for testing only.
   */
  trace?: boolean;
  [key: string]: unknown;
}

export interface StoredProviderConfig {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  encryptedKeys: EncryptedCredential[];
  settings: ProviderSettings;
  updatedAt: number;
}

export interface DecryptedProviderConfig extends StoredProviderConfig {
  keys: string[];
}

/** Per-request crypto context: unwraps the tenant DEK once and reuses it. */
export class TenantCryptoContext {
  readonly dek: Uint8Array;
  readonly kek: Uint8Array;
  readonly organizationId: string;
  readonly aad: Uint8Array;
  readonly keys: TenantKeys;

  constructor(
    organizationId: string,
    kek: Uint8Array,
    dek: Uint8Array,
    keys: TenantKeys,
  ) {
    this.organizationId = organizationId;
    this.kek = kek;
    this.dek = dek;
    this.aad = createEncryptionAad(organizationId);
    this.keys = keys;
  }

  static async create(
    env: Env,
    organizationId: string,
  ): Promise<TenantCryptoContext> {
    const kek = deriveKek(await getEncryptionKey(env));
    const store = new D1TenantKeyStore(env.DB);
    const { dek, keys } = await resolveTenantDek(kek, store, organizationId);
    return new TenantCryptoContext(organizationId, kek, dek, keys);
  }

  async encrypt(plaintext: string): Promise<EncryptedCredential> {
    return encryptCredential(this.dek, plaintext, this.aad);
  }

  async decrypt(credential: EncryptedCredential): Promise<string> {
    return decryptCredential(this.dek, credential, this.aad);
  }
}

function parseRow(row: ProviderConfigRow): StoredProviderConfig {
  const config = safeJsonParse(
    row.config,
    {} as {
      keys?: unknown[];
      settings?: ProviderSettings;
    },
  );
  return {
    id: row.id,
    provider: row.provider,
    name: row.name ?? "",
    enabled: row.enabled === 1,
    encryptedKeys: (config.keys ?? []) as EncryptedCredential[],
    settings: config.settings ?? {},
    updatedAt: 0,
  };
}

/** Read + decrypt a tenant's provider config. */
export async function getProviderConfig(
  env: Env,
  orgId: string,
  provider: string,
  crypto?: TenantCryptoContext,
): Promise<DecryptedProviderConfig | undefined> {
  const row = await env.DB.prepare(
    "SELECT id, organization_id, provider, name, enabled, config FROM provider_configs WHERE organization_id = ? AND provider = ?",
  )
    .bind(orgId, provider)
    .first<ProviderConfigRow>();
  if (!row) return undefined;
  const stored = parseRow(row);
  const ctx = crypto ?? (await TenantCryptoContext.create(env, orgId));
  const keys: string[] = [];
  for (const enc of stored.encryptedKeys) {
    keys.push(await ctx.decrypt(enc));
  }
  return { ...stored, keys };
}

export async function listProviderConfigs(
  env: Env,
  orgId: string,
  crypto?: TenantCryptoContext,
): Promise<DecryptedProviderConfig[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, organization_id, provider, name, enabled, config FROM provider_configs WHERE organization_id = ?",
  )
    .bind(orgId)
    .all<ProviderConfigRow>();
  const ctx = crypto ?? (await TenantCryptoContext.create(env, orgId));
  const out: DecryptedProviderConfig[] = [];
  for (const row of results) {
    const stored = parseRow(row);
    const keys: string[] = [];
    for (const enc of stored.encryptedKeys) {
      keys.push(await ctx.decrypt(enc));
    }
    out.push({ ...stored, keys });
  }
  return out;
}

export interface SaveProviderConfigInput {
  keys?: string[]; // plaintext keys to encrypt (replaces existing)
  enabled?: boolean;
  name?: string;
  settings?: ProviderSettings;
}

/** Insert or replace a tenant's provider config. Keys are envelope-encrypted. */
export async function saveProviderConfig(
  env: Env,
  orgId: string,
  provider: string,
  input: SaveProviderConfigInput,
  crypto?: TenantCryptoContext,
): Promise<DecryptedProviderConfig> {
  const ctx = crypto ?? (await TenantCryptoContext.create(env, orgId));
  const existing = await getProviderConfig(env, orgId, provider, ctx);

  const encryptedKeys =
    input.keys !== undefined
      ? await Promise.all(input.keys.map((k) => ctx.encrypt(k)))
      : (existing?.encryptedKeys ?? []);

  const nextConfig = {
    keys: encryptedKeys,
    settings: { ...(existing?.settings ?? {}), ...(input.settings ?? {}) },
  };

  const name = input.name ?? existing?.name ?? "";
  const now = nowSeconds();
  if (existing) {
    await env.DB.prepare(
      `UPDATE provider_configs SET config = ?, enabled = ?, name = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        JSON.stringify(nextConfig),
        input.enabled !== false ? 1 : 0,
        name,
        now,
        existing.id,
      )
      .run();
    return {
      ...existing,
      name,
      enabled: input.enabled !== false,
      encryptedKeys,
      settings: nextConfig.settings,
      keys: input.keys ?? existing.keys,
      updatedAt: now,
    };
  }

  const id = newId("pcfg");
  await env.DB.prepare(
    `INSERT INTO provider_configs (id, organization_id, provider, name, enabled, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      orgId,
      provider,
      name,
      input.enabled !== false ? 1 : 0,
      JSON.stringify(nextConfig),
      now,
      now,
    )
    .run();
  return {
    id,
    provider,
    name,
    enabled: input.enabled !== false,
    encryptedKeys,
    settings: nextConfig.settings,
    keys: input.keys ?? [],
    updatedAt: now,
  };
}

export async function deleteProviderConfig(
  env: Env,
  orgId: string,
  provider: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM provider_configs WHERE organization_id = ? AND provider = ?",
  )
    .bind(orgId, provider)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** pi-ai CredentialStore adapter backed by our encrypted provider_configs. */
export function createTenantCredentialStore(
  env: Env,
  organizationId: string,
): CredentialStore {
  let crypto: TenantCryptoContext | undefined;
  const ctx = async () =>
    (crypto ??= await TenantCryptoContext.create(env, organizationId));

  return {
    async read(providerId) {
      const config = await getProviderConfig(
        env,
        organizationId,
        providerId,
        await ctx(),
      );
      if (!config?.enabled || config.keys.length === 0) return undefined;
      // pi-ai supports one credential per provider; use the first active key.
      return { type: "api_key", key: config.keys[0] };
    },
    async list() {
      const configs = await listProviderConfigs(
        env,
        organizationId,
        await ctx(),
      );
      return configs
        .filter((c) => c.enabled && c.keys.length > 0)
        .map((c) => ({ providerId: c.provider, type: "api_key" as const }));
    },
    async modify(providerId, fn) {
      const current = await this.read(providerId);
      const next = await fn((current ?? undefined) as Credential);
      if (!next) return undefined;
      const key = (next as { key?: string }).key;
      if (!key) return undefined;
      await saveProviderConfig(
        env,
        organizationId,
        providerId,
        { keys: [key] },
        await ctx(),
      );
      return next;
    },
    async delete(providerId) {
      await deleteProviderConfig(env, organizationId, providerId);
    },
  };
}

export function newProviderConfigId(): string {
  return newUuid();
}
