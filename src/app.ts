import { alertsRouter } from "./api/alerts";
import { bootstrapRouter } from "./api/bootstrap";
import { emailAdminRouter } from "./api/email-admin";
import { keysRouter } from "./api/keys";
import { metricsRouter } from "./api/metrics";
import { providerConfigRouter } from "./api/provider-config";
import { teamRouter } from "./api/team";
import { tenantRouter } from "./api/tenant";
import { usageRouter } from "./api/usage";
import { getAuthFor } from "./auth/setup";
import { ensureBootstrapped } from "./bootstrap";
import {
  apiKeyAuthMiddleware,
  sessionAuthMiddleware,
} from "./middlewares/auth-required";
import { requireAdmin, requireOrgMember } from "./middlewares/rbac";
import {
  tenantPrefixGuardMiddleware,
  tenantPrefixMiddleware,
} from "./middlewares/tenant-prefix";
import { chatCompletionsV2 } from "./requests/chat_completions_v2";
import { modelsV2 } from "./requests/models_v2";
import { AppVariables } from "./types";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

export type AppBindings = { Bindings: Env; Variables: AppVariables };

/** Mutating admin routes require owner/admin; reads allow any org member. */
const adminWriteGuard = createMiddleware<AppBindings>((c, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    return requireAdmin()(c, next);
  }
  return next();
});

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: { message: "Internal server error" } }, 500);
  });
  app.notFound((c) => c.json({ error: { message: "Not found" } }, 404));

  // Self-serve bootstrap: generate runtime secrets + seed the default admin
  // on first boot, before any auth/session handling needs them.
  app.use("/api/bootstrap/*", async (c, next) => {
    await ensureBootstrapped(c.env);
    await next();
  });
  app.route("/api/bootstrap", bootstrapRouter);

  // Better Auth (content-auth): /api/auth/*
  app.use("/api/auth/*", async (c, next) => {
    await ensureBootstrapped(c.env);
    await next();
  });
  app.all("/api/auth/*", async (c) => {
    const auth = await getAuthFor(c.env);
    return auth.handler(c.req.raw);
  });

  // Admin control plane (Phase 2.1): provider credentials + API keys.
  // Session-authenticated; mutating routes are owner/admin, reads are member+.
  app.use(
    "/api/providers/*",
    sessionAuthMiddleware,
    requireOrgMember,
    adminWriteGuard,
  );
  app.use(
    "/api/keys/*",
    sessionAuthMiddleware,
    requireOrgMember,
    adminWriteGuard,
  );
  app.route("/api/providers", providerConfigRouter);
  app.route("/api/keys", keysRouter);

  // Team management (Phase 2.3): members + invitations. Reads are member+;
  // mutations are owner/admin via adminWriteGuard; owner-only transfers are
  // enforced inside teamRouter.
  app.use(
    "/api/team/*",
    sessionAuthMiddleware,
    requireOrgMember,
    adminWriteGuard,
  );
  app.route("/api/team", teamRouter);

  // Email admin control plane (Phase 2.2): templates, settings, logs.
  app.use(
    "/api/email/*",
    sessionAuthMiddleware,
    requireOrgMember,
    requireAdmin(),
  );
  app.route("/api/email", emailAdminRouter);

  // Alerting (Phase 5.3): config, test delivery, event history. Reads are
  // member+, config writes are owner/admin via adminWriteGuard.
  app.use(
    "/api/alerts/*",
    sessionAuthMiddleware,
    requireOrgMember,
    adminWriteGuard,
  );
  app.route("/api/alerts", alertsRouter);

  // Metrics + usage (Phase 3.1/3.3): reads for any org member, limit
  // updates are owner/admin via adminWriteGuard.
  app.use("/api/metrics/*", sessionAuthMiddleware, requireOrgMember);
  app.use(
    "/api/usage/*",
    sessionAuthMiddleware,
    requireOrgMember,
    adminWriteGuard,
  );
  app.route("/api/metrics", metricsRouter);
  app.route("/api/usage", usageRouter);

  // Tenant URL prefix (base URL) management: reads are member+, writes admin.
  app.use(
    "/api/tenant/*",
    sessionAuthMiddleware,
    requireOrgMember,
    adminWriteGuard,
  );
  app.route("/api/tenant", tenantRouter);

  // Tenant Open LLM Proxy — OpenAI-compatible endpoints (Phase 1 acceptance).
  // Authenticated with tenant programmatic API keys (api_keys table). Each
  // endpoint accepts an optional leading tenant URL prefix (`/proxy_xxx/v1/...`).
  const chatCompletions = (c: import("hono").Context<AppBindings>) => {
    const apiKeyAuth = c.get("apiKeyAuth")!;
    return chatCompletionsV2({
      request: c.req.raw,
      env: c.env,
      apiKeyAuth,
      ctx: c.executionCtx,
    });
  };
  const listModels = (c: import("hono").Context<AppBindings>) => {
    return modelsV2({
      env: c.env,
      apiKeyAuth: c.get("apiKeyAuth")!,
    });
  };

  app.post(
    "/v1/chat/completions",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    chatCompletions,
  );
  app.post(
    "/:tenantPrefix/v1/chat/completions",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    chatCompletions,
  );
  app.post(
    "/chat/completions",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    chatCompletions,
  );
  app.post(
    "/:tenantPrefix/chat/completions",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    chatCompletions,
  );
  app.get(
    "/v1/models",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    listModels,
  );
  app.get(
    "/:tenantPrefix/v1/models",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    listModels,
  );
  app.get(
    "/models",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    listModels,
  );
  app.get(
    "/:tenantPrefix/models",
    tenantPrefixMiddleware,
    apiKeyAuthMiddleware,
    tenantPrefixGuardMiddleware,
    listModels,
  );

  return app;
}
