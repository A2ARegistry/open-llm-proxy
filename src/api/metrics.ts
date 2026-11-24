import type { AppBindings } from "../app";
import { cacheUsageByModel, spendForRange } from "../metrics/cost-tracker";
import { keyDetailUsage } from "../metrics/key-detail";
import { usageByKey } from "../metrics/key-usage";
import { percentile } from "../metrics/percentile";
import {
  getRequest,
  listRequests,
  parseRequestFilters,
  requestFacets,
} from "../metrics/request-log";
import { speedByModel } from "../metrics/speed-stats";
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

// GET /api/metrics/cache — prompt-cache behavior per provider + model over
// the window: cache read/write tokens, hit rates, proxy response-cache hits.
metricsRouter.get("/cache", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end } = rangeParams(c);
  const invalid = validateRange(start, end);
  if (invalid) return c.json({ error: invalid }, 400);

  const usage = await cacheUsageByModel(c.env, orgId, start, end);
  return c.json({ start, end, usage });
});

// GET /api/metrics/speed — streaming speed per provider + model over the
// window: TTFT p50/p95, decode tokens/s, prefill tokens/s.
metricsRouter.get("/speed", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end } = rangeParams(c);
  const invalid = validateRange(start, end);
  if (invalid) return c.json({ error: invalid }, 400);

  const speed = await speedByModel(c.env, orgId, start, end);
  return c.json({ start, end, speed });
});

// GET /api/metrics/keys — requests, tokens, cost, errors and latency per API
// key over the window. Keyless (dashboard session) traffic is one row with a
// null key id.
metricsRouter.get("/keys", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end } = rangeParams(c);
  const invalid = validateRange(start, end);
  if (invalid) return c.json({ error: invalid }, 400);

  const keys = await usageByKey(c.env, orgId, start, end);
  return c.json({ start, end, keys });
});

// GET /api/metrics/keys/:id — one key's totals, time series, per-model
// split and lifetime spend over the window.
metricsRouter.get("/keys/:id", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end } = rangeParams(c);
  const invalid = validateRange(start, end);
  if (invalid) return c.json({ error: invalid }, 400);

  const usage = await keyDetailUsage(
    c.env,
    orgId,
    c.req.param("id"),
    start,
    end,
  );
  return c.json(usage);
});

// GET /api/metrics/requests — newest-first request rows plus total count.
// Filters: provider, model, apiKeyId ("none" = keyless), status, cache.
metricsRouter.get("/requests", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end, provider } = rangeParams(c);
  const invalid = validateRange(start, end);
  if (invalid) return c.json({ error: invalid }, 400);
  const filters = parseRequestFilters((k) => c.req.query(k));
  if (typeof filters === "string") return c.json({ error: filters }, 400);
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  const { requests, total } = await listRequests(
    c.env,
    orgId,
    { start, end, provider, ...filters },
    limit,
    offset,
  );
  return c.json({ requests, total, limit, offset });
});

// GET /api/metrics/requests/facets — providers and models in the window,
// for the request log's filter dropdowns.
metricsRouter.get("/requests/facets", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end } = rangeParams(c);
  const invalid = validateRange(start, end);
  if (invalid) return c.json({ error: invalid }, 400);

  const facets = await requestFacets(c.env, orgId, start, end);
  return c.json({ start, end, facets });
});

// GET /api/metrics/requests/:id — one request with its key and user.
metricsRouter.get("/requests/:id", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const request = await getRequest(c.env, orgId, c.req.param("id"));
  if (!request) return c.json({ error: "Request not found" }, 404);
  return c.json({ request });
});
