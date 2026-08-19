import type { AppBindings } from "../app";
import { TenantService } from "../db/tenant";
import {
  dailyCosts,
  spendForRange,
  spendLimitStatus,
  monthStartSeconds,
} from "../metrics/cost-tracker";
import { reconcileTenantDisable } from "../metrics/spend-guard";
import { nowSeconds } from "../utils/crypto";
import { Hono } from "hono";

export const usageRouter = new Hono<AppBindings>();

function range(c: { req: { query: (k: string) => string | undefined } }) {
  const now = nowSeconds();
  const q = (k: string) => c.req.query(k);
  const startRaw = q("start");
  const endRaw = q("end");
  const start = startRaw ? Math.floor(Number(startRaw)) : now - 30 * 24 * 3600;
  const end = endRaw ? Math.floor(Number(endRaw)) : now;
  return {
    start: Number.isFinite(start) ? start : now - 30 * 24 * 3600,
    end: Number.isFinite(end) ? end : now,
  };
}

// GET /api/usage/costs — daily cost breakout + totals.
usageRouter.get("/costs", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const { start, end } = range(c);
  if (start >= end) return c.json({ error: "start must be before end" }, 400);

  const days = await dailyCosts(c.env, orgId, start, end);
  const summary = await spendForRange(c.env, orgId, { start, end });
  return c.json({ days, summary });
});

// PUT /api/usage/limits — set per-tenant spend limits (owner/admin via app guard).
usageRouter.put("/limits", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;

  const body = (await c.req.json().catch(() => null)) as {
    dailyUsd?: unknown;
    monthlyUsd?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const next: { dailyUsd?: number | null; monthlyUsd?: number | null } = {};
  for (const key of ["dailyUsd", "monthlyUsd"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && (typeof value !== "number" || value < 0)) {
      return c.json(
        { error: `${key} must be a non-negative number or null` },
        400,
      );
    }
    next[key] = value as number | null;
  }
  if (Object.keys(next).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  const tenants = new TenantService(c.env.DB);
  const settings = await tenants.getSettings(orgId);
  const merged: { dailyUsd?: number; monthlyUsd?: number } = {
    ...settings.spendLimits,
  };
  for (const key of ["dailyUsd", "monthlyUsd"] as const) {
    if (next[key] === undefined) continue;
    if (next[key] === null) delete merged[key];
    else merged[key] = next[key]!;
  }
  await tenants.updateSettings(orgId, { spendLimits: merged });
  await reconcileTenantDisable(c.env, orgId);
  return c.json({ spendLimits: merged });
});

// GET /api/usage/alerts — spend vs limit with 80/90/100% thresholds.
usageRouter.get("/alerts", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const tenants = new TenantService(c.env.DB);
  const settings = await tenants.getSettings(orgId);
  const status = await spendLimitStatus(c.env, settings, orgId);

  const now = nowSeconds();
  const dayStart = now - (now % 86400);
  const monthStart = monthStartSeconds(now);

  const alert = (
    check: { usage: number; limit: number; level: number } | undefined,
  ) =>
    check
      ? {
          usageUsd: round2(check.usage),
          limitUsd: round2(check.limit),
          percent: Math.round(check.level * 100),
          breached: check.level >= 1,
          warning: check.level >= 0.8 && check.level < 1,
        }
      : null;

  return c.json({
    daily: {
      windowStart: dayStart,
      ...alert(status.daily),
    },
    monthly: {
      windowStart: monthStart,
      ...alert(status.monthly),
    },
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
