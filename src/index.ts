import { runAlertChecks } from "./alerts/evaluator";
import { createApp } from "./app";
import { MetricsBuffer } from "./durable/metrics-buffer";
import { RateLimiter } from "./durable/rate-limiter";
import { ResponseCache } from "./durable/response-cache";
import { SessionManager } from "./durable/session-manager";
import { sha256Hex } from "./utils/crypto";
import { initLogger } from "./utils/logger";
// Cloudflare Durable Objects
import { EmailingCacheDO } from "@contentgrowth/content-emailing/backend/EmailingCacheDO.js";

export { MetricsBuffer };
export { RateLimiter };
export { ResponseCache };
export { SessionManager };
export { EmailingCacheDO };

const app = createApp();

/**
 * True when the request carries a tenant programmatic API key (api_keys table).
 * Such traffic is routed to the Hono app (OpenAI-compatible /v1 endpoints).
 */
async function isTenantApiKey(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization");
  const xApiKey = request.headers.get("x-api-key");
  let key: string | null = null;
  if (header?.startsWith("Bearer ")) {
    key = header.slice(7).trim();
  } else if (xApiKey) {
    key = xApiKey.trim();
  }
  if (!key) return false;
  const hash = await sha256Hex(key);
  const row = await env.DB.prepare("SELECT id FROM api_keys WHERE key_hash = ?")
    .bind(hash)
    .first<{ id: string }>();
  return Boolean(row);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    initLogger(env);
    const url = new URL(request.url);

    // Admin/auth dashboard + tenant-key LLM traffic → Hono app.
    if (url.pathname.startsWith("/api")) {
      return app.fetch(request, env, ctx);
    }
    if (await isTenantApiKey(request, env)) {
      return app.fetch(request, env, ctx);
    }

    // Serve the dashboard SPA + its static assets to browser traffic.
    const hasApiAuth =
      request.headers.get("authorization") || request.headers.get("x-api-key");
    const accept = request.headers.get("accept") ?? "";
    const wantsHtml =
      accept.includes("text/html") ||
      request.headers.get("sec-fetch-dest") === "document";
    const isStaticAsset =
      url.pathname === "/" ||
      url.pathname.startsWith("/assets/") ||
      /\.(?:js|css|map|svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot|json)$/i.test(
        url.pathname,
      );
    const assets = (env as unknown as { ASSETS?: Fetcher }).ASSETS;
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      !hasApiAuth &&
      assets &&
      (wantsHtml || isStaticAsset)
    ) {
      return assets.fetch(request);
    }

    // Everything else (programmatic /v1 + /models traffic, unknown paths).
    return app.fetch(request, env, ctx);
  },

  /** Cron trigger: evaluate spend + error-rate alerts for every tenant. */
  async scheduled(_event, env, ctx) {
    initLogger(env);
    ctx.waitUntil(runAlertChecks(env));
  },
} satisfies ExportedHandler<Env>;
