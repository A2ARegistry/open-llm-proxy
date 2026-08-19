import { TenantKeys, rowToTenantKeys } from "../tenants/encryption";
import { newId, nowSeconds, safeJsonParse } from "../utils/crypto";

/** D1-backed TenantKeyStore (reads/writes `tenant_keys`). */
export class D1TenantKeyStore {
  constructor(private readonly db: D1Database) {}

  async get(organizationId: string): Promise<TenantKeys | undefined> {
    const { results } = await this.db
      .prepare(
        "SELECT organization_id, wrapped_dek, wrapped_dek_iv, kek_version FROM tenant_keys WHERE organization_id = ?",
      )
      .bind(organizationId)
      .all<{
        organization_id: string;
        wrapped_dek: string;
        wrapped_dek_iv: string;
        kek_version: number;
      }>();
    const row = results[0];
    return row ? rowToTenantKeys(row) : undefined;
  }

  async put(keys: TenantKeys): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tenant_keys (organization_id, wrapped_dek, wrapped_dek_iv, kek_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           wrapped_dek = excluded.wrapped_dek,
           wrapped_dek_iv = excluded.wrapped_dek_iv,
           kek_version = excluded.kek_version,
           updated_at = excluded.updated_at`,
      )
      .bind(
        keys.organizationId,
        keys.wrappedDek,
        keys.wrappedDekIv,
        keys.kekVersion,
        nowSeconds(),
        nowSeconds(),
      )
      .run();
  }
}

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  createdAt: string | number;
  metadata: string | null;
}

export interface TenantSettings {
  rateLimit?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
    burstSize?: number;
  };
  cache?: {
    enabled?: boolean;
    ttl?: number;
    maxSizeMb?: number;
  };
  defaultModel?: string;
  modelAllowlist?: string[];
  spendLimits?: {
    dailyUsd?: number;
    monthlyUsd?: number;
  };
  monitoring?: {
    enabled?: boolean;
    exporters?: { type: string; url?: string; endpoint?: string }[];
  };
  email?: {
    fromName?: string;
    fromAddress?: string;
    provider?: string;
  };
  [key: string]: unknown;
}

const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  rateLimit: { requestsPerMinute: 60, tokensPerMinute: 100000, burstSize: 10 },
  cache: { enabled: false, ttl: 3600, maxSizeMb: 100 },
  spendLimits: { dailyUsd: undefined, monthlyUsd: undefined },
  monitoring: { enabled: true, exporters: [{ type: "d1" }] },
};

export function defaultTenantSettings(): TenantSettings {
  return JSON.parse(JSON.stringify(DEFAULT_TENANT_SETTINGS)) as TenantSettings;
}

/** D1-backed tenant (organization) query layer. */
export class TenantService {
  constructor(private readonly db: D1Database) {}

  async getOrganization(id: string): Promise<OrganizationRow | undefined> {
    const { results } = await this.db
      .prepare("SELECT * FROM organizations WHERE id = ?")
      .bind(id)
      .all<OrganizationRow>();
    return results[0];
  }

  async listOrganizationsForUser(userId: string): Promise<OrganizationRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT o.* FROM organizations o
         JOIN members m ON m.organization_id = o.id
         WHERE m.user_id = ?
         ORDER BY o.createdAt DESC`,
      )
      .bind(userId)
      .all<OrganizationRow>();
    return results;
  }

  async getSettings(organizationId: string): Promise<TenantSettings> {
    const { results } = await this.db
      .prepare(
        "SELECT key, value FROM tenant_settings WHERE organization_id = ?",
      )
      .bind(organizationId)
      .all<{ key: string; value: string }>();
    const settings = defaultTenantSettings();
    for (const row of results) {
      settings[row.key] = safeJsonParse(row.value, settings[row.key]);
    }
    return settings;
  }

  async updateSettings(
    organizationId: string,
    patch: Partial<TenantSettings>,
  ): Promise<TenantSettings> {
    const current = await this.getSettings(organizationId);
    const next: TenantSettings = { ...current, ...patch };
    const tx = this.db.batch(
      Object.entries(next).map(([key, value]) =>
        this.db
          .prepare(
            `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(
            organizationId,
            key,
            JSON.stringify(value ?? null),
            nowSeconds(),
          ),
      ),
    );
    await tx;
    return next;
  }

  async setDefaultModel(organizationId: string, model: string): Promise<void> {
    await this.updateSettings(organizationId, { defaultModel: model });
  }

  /** Suspension status is derived from organizations.name (status field) or stored via tenant_settings. */
  async setStatus(
    organizationId: string,
    status: "active" | "suspended",
  ): Promise<void> {
    await this.updateSettings(organizationId, {
      status,
    } as Partial<TenantSettings>);
  }

  async getStatus(organizationId: string): Promise<string> {
    const settings = await this.getSettings(organizationId);
    return (settings.status as string) ?? "active";
  }
}

export function organizationId(prefix = "org"): string {
  return newId(prefix);
}
