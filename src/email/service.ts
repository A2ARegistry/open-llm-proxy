import { nowSeconds, safeJsonParse } from "../utils/crypto";
import { EmailService } from "@contentgrowth/content-emailing/backend";

export interface EmailSettings {
  provider?: string;
  fromName?: string;
  fromAddress?: string;
  sendpulseClientId?: string;
  sendpulseClientSecret?: string;
  sendgridApiKey?: string;
  resendApiKey?: string;
  brandName?: string;
  [key: string]: unknown;
}

/** Load tenant (organization) scoped email settings from tenant_settings. */
export async function loadTenantEmailSettings(
  env: Env,
  organizationId: string | null,
): Promise<EmailSettings | null> {
  if (!organizationId) return null;
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM tenant_settings WHERE organization_id = ? AND key LIKE 'email.%'",
  )
    .bind(organizationId)
    .all<{ key: string; value: string }>();
  if (results.length === 0) return null;
  const settings: EmailSettings = {};
  for (const row of results) {
    const key = row.key.replace(/^email\./, "");
    settings[key] = safeJsonParse(row.value, row.value);
  }
  return settings;
}

/** Persist tenant email settings into tenant_settings. */
export async function saveTenantEmailSettings(
  env: Env,
  organizationId: string,
  settings: EmailSettings,
): Promise<void> {
  const batch = Object.entries(settings)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) =>
      env.DB.prepare(
        `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(
        organizationId,
        `email.${key}`,
        JSON.stringify(value),
        nowSeconds(),
      ),
    );
  await env.DB.batch(batch);
}

export interface EmailServiceOptions {
  profile?: string;
  tenantId?: string | null;
}

/** Config shared by the admin routes and send-time EmailService. */
export function buildEmailConfig(env: Env) {
  return {
    emailTablePrefix: "system_email_",
    settingsTableName: "system_settings",
    settingsKeyPrefix: "system_email.",
    defaults: {
      fromName: (env as any).EMAIL_FROM_NAME || "Open LLM Proxy",
      fromAddress: (env as any).EMAIL_FROM_ADDRESS || "noreply@example.com",
      provider: "sendpulse",
    },
    sendpulseClientId: (env as any).SENDPULSE_CLIENT_ID,
    sendpulseClientSecret: (env as any).SENDPULSE_CLIENT_SECRET,
    settingsLoader: async (profile: string, tenantId?: string | null) => {
      if (profile === "tenant" && tenantId) {
        return loadTenantEmailSettings(env, tenantId);
      }
      // system profile: read from system_settings table
      const { results } = await env.DB.prepare(
        "SELECT key, value FROM system_settings WHERE key LIKE 'system_email.%'",
      ).all<{ key: string; value: string }>();
      if (results.length === 0) return null;
      const settings: EmailSettings = {};
      for (const row of results) {
        settings[row.key.replace(/^system_email\./, "")] = safeJsonParse(
          row.value,
          row.value,
        );
      }
      return settings;
    },
    settingsUpdater: async (
      profile: string,
      tenantId?: string | null,
      settings?: Record<string, unknown>,
    ) => {
      if (profile === "tenant" && tenantId) {
        await saveTenantEmailSettings(env, tenantId, settings as EmailSettings);
        return;
      }
      const batch = Object.entries(settings ?? {}).map(([key, value]) =>
        env.DB.prepare(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).bind(
          `system_email.${key}`,
          JSON.stringify(value ?? ""),
          nowSeconds(),
        ),
      );
      if (batch.length > 0) await env.DB.batch(batch);
    },
  };
}

/** Build a content-emailing EmailService wired to our D1 + tenant settings. */
export function createEmailService(env: Env): EmailService {
  return new EmailService(env, buildEmailConfig(env), null);
}

/** Send a template email to an organization-scoped recipient. */
export async function sendTemplateEmail(
  env: Env,
  params: {
    templateId: string;
    data: Record<string, unknown>;
    to: string;
    tenantId?: string | null;
    profile?: string;
    metadata?: Record<string, unknown>;
    userId?: string | null;
  },
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const emailService = createEmailService(env);
  return emailService.sendViaTemplate(params.templateId, params.data, {
    to: params.to,
    profile: params.profile || (params.tenantId ? "tenant" : "system"),
    tenantId: params.tenantId ?? null,
    metadata: {
      ...(params.metadata || {}),
      userId: params.userId || undefined,
    },
  });
}
