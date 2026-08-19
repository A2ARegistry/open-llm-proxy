import { newId, nowSeconds, safeJsonParse } from "../utils/crypto";

export const WEBHOOK_EVENTS = [
  "quota_exceeded",
  "high_error_rate",
  "test",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const ALERT_TO_WEBHOOK_EVENT: Record<string, WebhookEvent> = {
  spend_daily: "quota_exceeded",
  spend_monthly: "quota_exceeded",
  error_rate: "high_error_rate",
  test: "test",
};

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  enabled: boolean;
  createdAt: number;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  secret: string | null;
  enabled: number;
  created_at: number;
}

function toSubscription(row: WebhookRow): WebhookSubscription {
  return {
    id: row.id,
    url: row.url,
    events: safeJsonParse(row.events, [] as string[]),
    secret: row.secret,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export async function listWebhookSubscriptions(
  env: Env,
  organizationId: string,
): Promise<WebhookSubscription[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM webhooks WHERE organization_id = ? ORDER BY created_at ASC",
  )
    .bind(organizationId)
    .all<WebhookRow>();
  return results.map(toSubscription);
}

export function validateWebhookInput(
  body: Record<string, unknown>,
): { url: string; events: string[]; secret: string | null } | string {
  if (typeof body.url !== "string") return "url must be a string";
  let url: string;
  try {
    const parsed = new URL(body.url.trim());
    if (!["https:", "http:"].includes(parsed.protocol)) {
      return "url must be an http(s) URL";
    }
    url = parsed.toString();
  } catch {
    return "url must be a valid URL";
  }
  if (url.length > 500) return "url is too long";

  let events: string[] = [];
  if (body.events !== undefined) {
    if (!Array.isArray(body.events)) return "events must be an array";
    for (const event of body.events) {
      if (
        typeof event !== "string" ||
        !(WEBHOOK_EVENTS as readonly string[]).includes(event)
      ) {
        return `events must be one of: ${WEBHOOK_EVENTS.join(", ")}`;
      }
    }
    events = body.events as string[];
  }

  let secret: string | null = null;
  if (body.secret !== undefined) {
    if (typeof body.secret !== "string" || body.secret.length > 256) {
      return "secret must be a string of at most 256 chars";
    }
    secret = body.secret === "" ? null : body.secret;
  }

  return { url, events, secret };
}

export async function createWebhookSubscription(
  env: Env,
  organizationId: string,
  input: { url: string; events: string[]; secret: string | null },
): Promise<WebhookSubscription> {
  const id = newId("wh");
  await env.DB.prepare(
    `INSERT INTO webhooks (id, organization_id, url, events, secret, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      id,
      organizationId,
      input.url,
      JSON.stringify(input.events),
      input.secret,
      nowSeconds(),
    )
    .run();
  return {
    id,
    url: input.url,
    events: input.events,
    secret: input.secret,
    enabled: true,
    createdAt: nowSeconds(),
  };
}

export async function updateWebhookSubscription(
  env: Env,
  organizationId: string,
  id: string,
  patch: Partial<{
    url: string;
    events: string[];
    secret: string | null;
    enabled: boolean;
  }>,
): Promise<WebhookSubscription | null> {
  const existing = await env.DB.prepare(
    "SELECT * FROM webhooks WHERE id = ? AND organization_id = ?",
  )
    .bind(id, organizationId)
    .first<WebhookRow>();
  if (!existing) return null;
  const next: WebhookSubscription = {
    ...toSubscription(existing),
    ...patch,
  };
  await env.DB.prepare(
    `UPDATE webhooks SET url = ?, events = ?, secret = ?, enabled = ? WHERE id = ? AND organization_id = ?`,
  )
    .bind(
      next.url,
      JSON.stringify(next.events),
      next.secret,
      next.enabled ? 1 : 0,
      id,
      organizationId,
    )
    .run();
  return next;
}

export async function deleteWebhookSubscription(
  env: Env,
  organizationId: string,
  id: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM webhooks WHERE id = ? AND organization_id = ?",
  )
    .bind(id, organizationId)
    .run();
  return res.meta.changes > 0;
}

/** True if a subscription should receive the given webhook event. */
export function matchesWebhookEvent(events: string[], event: string): boolean {
  return events.includes("*") || events.includes(event);
}

/** HMAC-SHA256 signature for the raw JSON payload (optional secret). */
export async function signWebhookPayload(
  secret: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deliver an event to every enabled subscription that subscribes to it. */
export async function deliverWebhooks(
  env: Env,
  organizationId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<{
  deliveries: number;
  failures: number;
  sent: { id: string; ok: boolean }[];
}> {
  const webhookEvent = ALERT_TO_WEBHOOK_EVENT[eventType];
  const subscriptions = await listWebhookSubscriptions(env, organizationId);
  let deliveries = 0;
  let failures = 0;
  const sent: { id: string; ok: boolean }[] = [];

  for (const sub of subscriptions) {
    if (!sub.enabled) continue;
    if (webhookEvent && !matchesWebhookEvent(sub.events, webhookEvent))
      continue;
    const rawBody = JSON.stringify({
      ...payload,
      event: webhookEvent ?? eventType,
      webhookId: sub.id,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (sub.secret) {
      headers["x-open-llm-proxy-signature"] =
        `sha256=${await signWebhookPayload(sub.secret, rawBody)}`;
    }
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers,
        body: rawBody,
      });
      const ok = res.ok;
      sent.push({ id: sub.id, ok });
      if (ok) deliveries += 1;
      else failures += 1;
    } catch {
      sent.push({ id: sub.id, ok: false });
      failures += 1;
    }
  }
  return { deliveries, failures, sent };
}
