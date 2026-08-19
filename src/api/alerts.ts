import {
  loadAlertSettings,
  saveAlertSettings,
  validateAlertPatch,
} from "../alerts/config";
import {
  createWebhookSubscription,
  deliverWebhooks,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
  validateWebhookInput,
  WEBHOOK_EVENTS,
} from "../alerts/webhooks";
import type { AppBindings } from "../app";
import { TenantService } from "../db/tenant";
import { sendTemplateEmail } from "../email/service";
import { Hono } from "hono";

export const alertsRouter = new Hono<AppBindings>();

// GET /api/alerts/config — current alert settings.
alertsRouter.get("/config", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const settings = loadAlertSettings(
    await new TenantService(c.env.DB).getSettings(orgId),
  );
  return c.json({ alerts: settings });
});

// PUT /api/alerts/config — owner/admin via app guard.
alertsRouter.put("/config", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const patch = validateAlertPatch(body);
  if (typeof patch === "string") return c.json({ error: patch }, 400);
  const alerts = await saveAlertSettings(c.env, orgId, patch);
  return c.json({ alerts });
});

// GET /api/alerts/events — recent alert history for this org.
alertsRouter.get("/events", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1),
    100,
  );
  const { results } = await c.env.DB.prepare(
    "SELECT id, event_type, provider, level, channel, status, created_at FROM alert_events WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(orgId, limit)
    .all<{
      id: string;
      event_type: string;
      provider: string | null;
      level: number;
      channel: string;
      status: string;
      created_at: number;
    }>();
  return c.json({
    events: results.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      provider: r.provider,
      level: r.level,
      channel: r.channel,
      status: r.status,
      createdAt: r.created_at,
    })),
  });
});

// GET /api/alerts/webhooks — list webhook subscriptions.
alertsRouter.get("/webhooks", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const webhooks = await listWebhookSubscriptions(c.env, orgId);
  return c.json({ webhooks, events: WEBHOOK_EVENTS });
});

// POST /api/alerts/webhooks — subscribe a URL to alert events.
alertsRouter.post("/webhooks", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const input = validateWebhookInput(body);
  if (typeof input === "string") return c.json({ error: input }, 400);
  if (input.events.length === 0) {
    return c.json({ error: "Select at least one event to subscribe to" }, 400);
  }
  const webhook = await createWebhookSubscription(c.env, orgId, input);
  return c.json({ webhook }, 201);
});

// PATCH /api/alerts/webhooks/:id — update URL/events/secret/enabled.
alertsRouter.patch("/webhooks/:id", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const patch: Record<string, unknown> = { ...body };
  if (
    body.url !== undefined ||
    body.events !== undefined ||
    body.secret !== undefined
  ) {
    const input = validateWebhookInput({
      url: body.url,
      events: body.events,
      secret: body.secret,
    });
    if (typeof input === "string") return c.json({ error: input }, 400);
    if (input.url !== undefined) patch.url = input.url;
    if (input.events !== undefined) patch.events = input.events;
    if (input.secret !== undefined) patch.secret = input.secret;
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  const webhook = await updateWebhookSubscription(
    c.env,
    orgId,
    c.req.param("id"),
    patch,
  );
  if (!webhook) return c.json({ error: "Webhook not found" }, 404);
  return c.json({ webhook });
});

// DELETE /api/alerts/webhooks/:id
alertsRouter.delete("/webhooks/:id", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const ok = await deleteWebhookSubscription(c.env, orgId, c.req.param("id"));
  if (!ok) return c.json({ error: "Webhook not found" }, 404);
  return c.json({ ok: true });
});

// POST /api/alerts/test — send a sample alert email + webhook now.
alertsRouter.post("/test", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const org = await c.env.DB.prepare(
    "SELECT name FROM organizations WHERE id = ?",
  )
    .bind(orgId)
    .first<{ name: string }>();
  const orgName = org?.name ?? orgId;
  const alertSettings = loadAlertSettings(
    await new TenantService(c.env.DB).getSettings(orgId),
  );

  const emailResult = alertSettings.emailEnabled
    ? await sendTemplateEmail(c.env, {
        templateId: "quota_exceeded",
        to: session.email ?? "",
        data: {
          user_name: session.email ?? orgName,
          organization_name: orgName,
          brand_name: c.env.APP_NAME,
          percent: 80,
          current_spend: "0.00",
          limit: "0.00",
          suspended: false,
        },
        tenantId: orgId,
        profile: "tenant",
        userId: session.userId,
        metadata: { kind: "test_alert" },
      })
    : { success: true, messageId: undefined };

  const payload = {
    type: "test",
    organizationId: orgId,
    organizationName: orgName,
    level: 80,
    sentAt: Math.floor(Date.now() / 1000),
  };
  const { deliveries, failures } = await deliverWebhooks(
    c.env,
    orgId,
    "test",
    payload,
  );

  return c.json({
    email: emailResult,
    webhooks: { delivered: deliveries, failed: failures },
  });
});
