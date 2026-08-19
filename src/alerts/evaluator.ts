import { Env } from "../../worker-configuration.d";
import { TenantService, type TenantSettings } from "../db/tenant";
import { sendTemplateEmail } from "../email/service";
import { monthStartSeconds, spendLimitStatus } from "../metrics/cost-tracker";
import { newId, nowSeconds } from "../utils/crypto";
import { loadAlertSettings, type AlertSettings } from "./config";
import { deliverWebhooks } from "./webhooks";

const SPEND_THRESHOLD = 0.8;
const SPEND_EMAIL_TEMPLATE = "quota_exceeded";
const ERROR_EMAIL_TEMPLATE = "high_error_rate";

export interface AlertCheckResult {
  organizationsChecked: number;
  alertsSent: number;
  deliveries: number;
  failures: number;
}

interface ProviderErrorRow {
  provider: string;
  requests: number;
  errors: number;
}

interface Recipient {
  email: string;
  name: string | null;
  userId: string;
}

export async function listOrganizations(env: Env): Promise<{ id: string }[]> {
  const { results } = await env.DB.prepare("SELECT id FROM organizations").all<{
    id: string;
  }>();
  return results;
}

/** Owner + admin members (email alert recipients). */
export async function getAlertRecipients(
  env: Env,
  organizationId: string,
): Promise<Recipient[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.email, u.name, u.id AS userId
     FROM members m JOIN users u ON u.id = m.userId
     WHERE m.organizationId = ? AND m.role IN ('owner', 'admin')
       AND u.email IS NOT NULL AND u.email <> ''`,
  )
    .bind(organizationId)
    .all<Recipient>();
  return results;
}

async function orgName(env: Env, organizationId: string): Promise<string> {
  const org = await new TenantService(env.DB).getOrganization(organizationId);
  return org?.name ?? organizationId;
}

async function recentEvent(
  env: Env,
  organizationId: string,
  eventType: string,
  provider: string | null,
  level: number,
  cooldownSeconds: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM alert_events
     WHERE organization_id = ? AND event_type = ? AND level = ?
       AND (provider IS NULL AND ? IS NULL OR provider = ?)
       AND created_at >= ?
     LIMIT 1`,
  )
    .bind(
      organizationId,
      eventType,
      level,
      provider,
      provider ?? null,
      nowSeconds() - cooldownSeconds,
    )
    .first<{ id: string }>();
  return Boolean(row);
}

async function recordEvent(
  env: Env,
  organizationId: string,
  eventType: string,
  provider: string | null,
  level: number,
  channel: string,
  status: string,
  messageId: string | null,
  payload: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO alert_events
       (id, organization_id, event_type, provider, level, channel, status, message_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("evt"),
      organizationId,
      eventType,
      provider,
      level,
      channel,
      status,
      messageId,
      JSON.stringify(payload ?? null),
      nowSeconds(),
    )
    .run();
}

/** Deliver one alert: email to owners/admins + webhook when configured. */
async function deliver(
  env: Env,
  organizationId: string,
  organizationName: string,
  eventType: string,
  provider: string | null,
  level: number,
  emailData: (recipient: Recipient) => Record<string, unknown>,
  webhookPayload: Record<string, unknown>,
  settings: AlertSettings,
): Promise<{ deliveries: number; failures: number }> {
  let deliveries = 0;
  let failures = 0;

  if (settings.emailEnabled) {
    const recipients = await getAlertRecipients(env, organizationId);
    for (const recipient of recipients) {
      const result = await sendTemplateEmail(env, {
        templateId:
          eventType === "error_rate"
            ? ERROR_EMAIL_TEMPLATE
            : SPEND_EMAIL_TEMPLATE,
        to: recipient.email,
        data: emailData(recipient),
        tenantId: organizationId,
        profile: "tenant",
        userId: recipient.userId,
        metadata: { kind: "alert", eventType, provider: provider ?? undefined },
      });
      await recordEvent(
        env,
        organizationId,
        eventType,
        provider,
        level,
        "email",
        result.success ? "sent" : "failed",
        result.messageId ?? null,
        { to: recipient.email },
      );
      if (result.success) deliveries += 1;
      else failures += 1;
    }
  }

  const webhookResult = await deliverWebhooks(
    env,
    organizationId,
    eventType,
    webhookPayload,
  );
  for (const item of webhookResult.sent) {
    await recordEvent(
      env,
      organizationId,
      eventType,
      provider,
      level,
      "webhook",
      item.ok ? "sent" : "failed",
      null,
      { webhookId: item.id },
    );
  }
  deliveries += webhookResult.deliveries;
  failures += webhookResult.failures;

  return { deliveries, failures };
}

/** Spend alerts: escalate at 80% / 90% / 100% of each configured limit. */
async function checkSpendAlerts(
  env: Env,
  organizationId: string,
  organizationName: string,
  settings: TenantSettings,
  alertSettings: AlertSettings,
): Promise<{ sent: number; deliveries: number; failures: number }> {
  const status = await spendLimitStatus(env, settings, organizationId);
  const cooldown = alertSettings.cooldownMinutes * 60;
  const now = nowSeconds();
  const dayStart = now - (now % 86400);
  const monthStart = monthStartSeconds(now);
  let sent = 0;
  let deliveries = 0;
  let failures = 0;

  for (const [windowKey, check, windowStart] of [
    ["daily", status.daily, dayStart],
    ["monthly", status.monthly, monthStart],
  ] as const) {
    if (!check || check.level < SPEND_THRESHOLD) continue;
    const level = check.level >= 1 ? 100 : check.level >= 0.9 ? 90 : 80;
    const eventType = `spend_${windowKey}`;
    if (
      await recentEvent(env, organizationId, eventType, null, level, cooldown)
    ) {
      continue;
    }
    const result = await deliver(
      env,
      organizationId,
      organizationName,
      eventType,
      null,
      level,
      (r) => ({
        user_name: r.name ?? r.email,
        organization_name: organizationName,
        brand_name: env.APP_NAME,
        percent: level,
        current_spend: round2(check.usage),
        limit: round2(check.limit),
        suspended: check.level >= 1,
      }),
      {
        type: eventType,
        organizationId,
        organizationName,
        level,
        windowStart,
        usageUsd: round2(check.usage),
        limitUsd: round2(check.limit),
        sentAt: nowSeconds(),
      },
      alertSettings,
    );
    sent += 1;
    deliveries += result.deliveries;
    failures += result.failures;
  }
  return { sent, deliveries, failures };
}

/** Error-rate alerts: per-provider failure rate over the lookback window. */
async function checkErrorRateAlerts(
  env: Env,
  organizationId: string,
  organizationName: string,
  alertSettings: AlertSettings,
): Promise<{ sent: number; deliveries: number; failures: number }> {
  const now = nowSeconds();
  const windowSeconds = alertSettings.errorWindowMinutes * 60;
  const cooldown = alertSettings.cooldownMinutes * 60;

  const { results } = await env.DB.prepare(
    `SELECT provider,
       COUNT(*) AS requests,
       SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
     FROM request_metrics
     WHERE organization_id = ? AND timestamp >= ? AND timestamp < ?
     GROUP BY provider`,
  )
    .bind(organizationId, now - windowSeconds, now)
    .all<ProviderErrorRow>();

  let sent = 0;
  let deliveries = 0;
  let failures = 0;

  for (const row of results) {
    if (row.requests < alertSettings.errorMinRequests) continue;
    const pct = (row.errors / row.requests) * 100;
    if (pct <= alertSettings.errorThresholdPct) continue;
    const level = Math.round(pct * 10) / 10;
    if (
      await recentEvent(
        env,
        organizationId,
        "error_rate",
        row.provider,
        level,
        cooldown,
      )
    ) {
      continue;
    }
    const result = await deliver(
      env,
      organizationId,
      organizationName,
      "error_rate",
      row.provider,
      level,
      (r) => ({
        user_name: r.name ?? r.email,
        organization_name: organizationName,
        brand_name: env.APP_NAME,
        provider: row.provider,
        error_rate: level,
        window_minutes: alertSettings.errorWindowMinutes,
      }),
      {
        type: "error_rate",
        organizationId,
        organizationName,
        provider: row.provider,
        level,
        errorRatePct: level,
        windowMinutes: alertSettings.errorWindowMinutes,
        requests: row.requests,
        errors: row.errors,
        sentAt: now,
      },
      alertSettings,
    );
    sent += 1;
    deliveries += result.deliveries;
    failures += result.failures;
  }
  return { sent, deliveries, failures };
}

/**
 * Evaluate every organization for spend and error-rate alerts and deliver
 * them. Invoked from the Worker `scheduled` handler (cron) — see index.ts.
 */
export async function runAlertChecks(env: Env): Promise<AlertCheckResult> {
  const orgs = await listOrganizations(env);
  const result: AlertCheckResult = {
    organizationsChecked: orgs.length,
    alertsSent: 0,
    deliveries: 0,
    failures: 0,
  };

  for (const org of orgs) {
    try {
      const tenants = new TenantService(env.DB);
      const settings = await tenants.getSettings(org.id);
      const alertSettings = loadAlertSettings(settings);
      if (!alertSettings.enabled) continue;
      const organizationName = await orgName(env, org.id);

      const spend = await checkSpendAlerts(
        env,
        org.id,
        organizationName,
        settings,
        alertSettings,
      );
      const errors = await checkErrorRateAlerts(
        env,
        org.id,
        organizationName,
        alertSettings,
      );
      result.alertsSent += spend.sent + errors.sent;
      result.deliveries += spend.deliveries + errors.deliveries;
      result.failures += spend.failures + errors.failures;
    } catch (err) {
      console.error(`[alerts] check failed for org ${org.id}:`, err);
      result.failures += 1;
    }
  }
  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
