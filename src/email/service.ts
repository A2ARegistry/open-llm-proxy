import { nowSeconds, safeJsonParse } from "../utils/crypto";
import { EmailService as BaseEmailService } from "@contentgrowth/content-emailing/backend";

/**
 * Extended EmailService with a 'console' provider for development
 * that logs emails instead of sending them.
 */
class EmailServiceWithConsole extends BaseEmailService {
  /**
   * Override sendEmail to add 'console' provider support
   */
  async sendEmail({
    to,
    subject,
    html,
    text,
    from,
    profile = "system",
    tenantId = null,
    provider = null,
    templateId = "direct",
    userId = null,
    batchId = null,
    metadata = {},
  }: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    from?: { name?: string; address?: string };
    profile?: string;
    tenantId?: string | null;
    provider?: string | null;
    templateId?: string;
    userId?: string | null;
    batchId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const settings = await this.loadSettings(profile, tenantId ?? undefined);
    const useProvider = provider || settings.provider || "mailchannels";

    // Handle 'console' provider - just log to console
    if (useProvider === "console") {
      console.log("\n" + "=".repeat(80));
      console.log("[EmailService] 📧 Console Email (Development Mode)");
      console.log("=".repeat(80));
      console.log(`To: ${to}`);
      console.log(
        `From: ${from?.name || settings.fromName} <${from?.address || settings.fromAddress}>`,
      );
      console.log(`Subject: ${subject}`);
      console.log(`Template: ${templateId}`);
      if (userId) console.log(`User ID: ${userId}`);
      console.log("-".repeat(80));
      console.log("HTML Body:");
      console.log(html.substring(0, 500) + (html.length > 500 ? "..." : ""));
      if (text) {
        console.log("-".repeat(80));
        console.log("Text Body (Plain):");
        // Decode HTML entities for better readability in console
        const plainText = text
          .replace(/&#x2F;/g, "/")
          .replace(/&#x3D;/g, "=")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        console.log(
          plainText.substring(0, 1000) + (plainText.length > 1000 ? "..." : ""),
        );
      }
      console.log("=".repeat(80) + "\n");

      // Log as sent
      if (this.emailLogger) {
        try {
          await this.emailLogger({
            event: "sent",
            recipientEmail: to,
            recipientUserId: userId,
            templateId,
            subject,
            provider: "console",
            messageId: `console-${Date.now()}`,
            batchId,
            metadata,
          });
        } catch {
          // ignore
        }
      }

      return { success: true, messageId: `console-${Date.now()}` };
    }

    // For all other providers, use the base implementation
    return super.sendEmail({
      to,
      subject,
      html,
      text,
      from,
      profile,
      tenantId: tenantId ?? undefined,
      provider,
      templateId,
      userId,
      batchId,
      metadata,
    } as any);
  }
}

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
  // Use EMAIL_PROVIDER env var if set, otherwise default to 'console' for development
  // Supported providers: 'console' (logs only), 'mailchannels', 'sendgrid', 'resend', 'sendpulse'
  const defaultProvider = (env as any).EMAIL_PROVIDER || "console";

  return {
    emailTablePrefix: "system_email_",
    settingsTableName: "system_settings",
    settingsKeyPrefix: "system_email.",
    defaults: {
      fromName: (env as any).EMAIL_FROM_NAME || "Open LLM Proxy",
      fromAddress: (env as any).EMAIL_FROM_ADDRESS || "noreply@example.com",
      provider: defaultProvider,
    },
    // Provider-specific credentials (pass all of them, EmailService will use the right ones)
    sendpulseClientId: (env as any).SENDPULSE_CLIENT_ID,
    sendpulseClientSecret: (env as any).SENDPULSE_CLIENT_SECRET,
    resendApiKey: (env as any).RESEND_API_KEY,
    sendgridApiKey: (env as any).SENDGRID_API_KEY,
    mailchannelsApiKey: (env as any).MAILCHANNELS_API_KEY,
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
export function createEmailService(env: Env): EmailServiceWithConsole {
  return new EmailServiceWithConsole(env, buildEmailConfig(env), null);
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
