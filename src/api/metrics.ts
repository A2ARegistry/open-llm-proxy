import type { AppBindings } from "../app";
import { spendForRange } from "../metrics/cost-tracker";
import { Hono } from "hono";

export const metricsRouter = new Hono<AppBindings>();

function rangeParams(c: { req: { query: (k: string) => string | undefined } }) {
  const now = Math.floor(Date.now() / 1000);
  const q = (k: string) => c.req.query(k);
  const startRaw = q("start");
  const endRaw = q("end");
  const start = startRaw ? Math.floor(Number(startRaw)) : now - 24 * 3600;
  const end = endRaw ? Math.floor(Number(endRaw)) : now;
  return {
    start: Number.isFinite(start) ? start : now - 24 * 3600,
    end: Number.isFinite(end) ? end : now,
    provider: q("provider") ?? undefined,
    model: q("model") ?? undefined,
  };
}

function validateRange(start: number, end: number): string | null {
  if (start >= end) return "start must be before end";
  if (end - start > 90 * 24 * 3600) return "range must be <= 90 days";
  return null;
}

// GET /api/metrics/summary — aggregated throughput/cost/errors for the tenant.
metricsRouter.get("/summary", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end, provider, model } = rangeParams(c);
  const invalid = validateRange(start, end);
  if (invalid) return c.json({ error: invalid }, 400);

  const summary = await spendForRange(c.env, orgId, {
    start,
    end,
    provider,
    model,
  });
  return c.json({ summary });
});

// GET /api/metrics/latency — p50/p95/p99 per provider over the window.
metricsRouter.get("/latency", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end, provider } = rangeParams(c);

  const where: string[] = [
    "organization_id = ?",
    "timestamp >= ?",
    "timestamp < ?",
    "status_code < 400",
  ];
  const params: (string | number)[] = [orgId, start, end];
  if (provider) {
    where.push("provider = ?");
    params.push(provider);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT provider, latency_ms FROM request_metrics WHERE ${where.join(" AND ")} ORDER BY provider, latency_ms`,
  )
    .bind(...params)
    .all<{ provider: string; latency_ms: number }>();

  const byProvider = new Map<string, number[]>();
  for (const row of results) {
    const list = byProvider.get(row.provider) ?? [];
    list.push(row.latency_ms);
    byProvider.set(row.provider, list);
  }

  const percentile = (sorted: number[], p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
    return sorted[Math.max(idx, 0)];
  };

  const latency = Array.from(byProvider.entries()).map(([pv, vals]) => {
    const sorted = vals.sort((a, b) => a - b);
    const n = sorted.length;
    const avg = sorted.reduce((a, b) => a + b, 0) / n;
    return {
      provider: pv,
      requests: n,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      avg: Math.round(avg),
    };
  });

  return c.json({ start, end, latency });
});

// GET /api/metrics/requests — recent request rows (tenant-scoped).
metricsRouter.get("/requests", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end, provider } = rangeParams(c);
  const q = (k: string) => c.req.query(k);
  const limit = Math.min(Number(q("limit")) || 50, 200);
  const offset = Math.max(Number(q("offset")) || 0, 0);

  const where: string[] = [
    "organization_id = ?",
    "timestamp >= ?",
    "timestamp < ?",
  ];
  const params: (string | number)[] = [orgId, start, end];
  if (provider) {
    where.push("provider = ?");
    params.push(provider);
  }
  params.push(String(limit), String(offset));

  const { results } = await c.env.DB.prepare(
    `SELECT id, api_key_id, timestamp, provider, model, method, status_code, latency_ms,
            tokens_input, tokens_output, tokens_cached, cost_usd, error_message, cache_hit
     FROM request_metrics WHERE ${where.join(" AND ")}
     ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params)
    .all();
  return c.json({ requests: results as unknown[] });
});
