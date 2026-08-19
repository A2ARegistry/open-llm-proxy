import type { AppBindings } from "../app";
import {
  createEmailService,
  loadTenantEmailSettings,
  saveTenantEmailSettings,
  sendTemplateEmail,
} from "../email/service";
import { EmailLogger } from "@contentgrowth/content-emailing/backend";
import { Hono } from "hono";

/**
 * Email admin control plane for the dashboard (Phase 2.2): template CRUD,
 * tenant-scoped sending settings, and delivery logs. Mounted in app.ts behind
 * session + owner/admin RBAC.
 */
export const emailAdminRouter = new Hono<AppBindings>();

// GET /api/email/templates
emailAdminRouter.get("/templates", async (c) => {
  const templates = await createEmailService(c.env).getAllTemplates();
  return c.json({ templates });
});

// GET /api/email/templates/:id
emailAdminRouter.get("/templates/:id", async (c) => {
  const template = await createEmailService(c.env).getTemplate(
    c.req.param("id"),
  );
  if (!template) return c.json({ error: "Template not found" }, 404);
  return c.json({ template });
});

// POST /api/email/templates — create or update a template.
emailAdminRouter.post("/templates", async (c) => {
  const data = await c.req.json().catch(() => null);
  if (!data) return c.json({ error: "Invalid JSON body" }, 400);
  await createEmailService(c.env).saveTemplate(data, "admin");
  return c.json({ success: true });
});

// DELETE /api/email/templates/:id
emailAdminRouter.delete("/templates/:id", async (c) => {
  await createEmailService(c.env).deleteTemplate(c.req.param("id"));
  return c.json({ success: true });
});

// POST /api/email/templates/:id/preview — render with sample data.
emailAdminRouter.post("/templates/:id/preview", async (c) => {
  const data = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const result = await createEmailService(c.env).renderTemplate(
    c.req.param("id"),
    data,
  );
  return c.json({ preview: result });
});

// POST /api/email/templates/:id/test — deliver a test email.
emailAdminRouter.post("/templates/:id/test", async (c) => {
  const session = c.get("session")!;
  const body = (await c.req.json().catch(() => null)) as {
    to?: string;
    data?: Record<string, unknown>;
  } | null;
  const to = body?.to ?? session.email;
  const result = await sendTemplateEmail(c.env, {
    templateId: c.req.param("id"),
    to,
    data: body?.data ?? {},
    tenantId: session.organizationId,
    profile: "tenant",
    userId: session.userId,
    metadata: { kind: "test_email" },
  });
  if (!result.success) {
    return c.json({ error: result.error || "Failed to send test email" }, 500);
  }
  return c.json({ success: true, messageId: result.messageId });
});

// GET /api/email/settings — tenant-scoped email settings.
emailAdminRouter.get("/settings", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const envVars = c.env as unknown as Record<string, string | undefined>;
  const settings = await loadTenantEmailSettings(c.env, orgId);
  return c.json({
    settings: {
      provider: settings?.provider ?? "sendpulse",
      fromName:
        settings?.fromName ?? envVars.EMAIL_FROM_NAME ?? "Open LLM Proxy",
      fromAddress:
        settings?.fromAddress ??
        envVars.EMAIL_FROM_ADDRESS ??
        "noreply@example.com",
      brandName: settings?.brandName ?? envVars.APP_NAME ?? "Open LLM Proxy",
      ...settings,
    },
  });
});

// POST /api/email/settings — persist tenant-scoped email settings.
emailAdminRouter.post("/settings", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);
  await saveTenantEmailSettings(c.env, orgId, body);
  return c.json({ success: true });
});

// GET /api/email/logs — recent delivery log entries (EmailLogger shape).
emailAdminRouter.get("/logs", async (c) => {
  const logger = new EmailLogger(c.env.DB);
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1),
    100,
  );
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
  const status = c.req.query("status") || undefined;
  const template = c.req.query("template") || undefined;
  const email = c.req.query("email") || undefined;
  const { logs, total } = await logger.query({
    limit,
    offset,
    status,
    templateId: template,
    recipientEmail: email,
  });
  return c.json({ logs, total });
});

// GET /api/email/stats?days=7 — delivery summary for the dashboard.
emailAdminRouter.get("/stats", async (c) => {
  const days = Math.min(
    Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1),
    90,
  );
  const stats = await new EmailLogger(c.env.DB).getStats(days);
  return c.json(stats);
});
