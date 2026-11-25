// [fork] W13: electricity use and cost of the self-hosted box (Power page).
import type { AppBindings } from "../app";
import { auditLog } from "../audit/audit-logger";
import { TenantService } from "../db/tenant";
import { requireAdmin } from "../middlewares/rbac";
import { dayPeriods, isValidTimeZone, monthPeriods } from "../power/periods";
import { loadPowerData } from "../power/power-query";
import { applyPowerPatch, parsePowerSettings } from "../power/power-settings";
import { idleFloor, projectUsd, summarize } from "../power/power-summary";
import { nowSeconds } from "../utils/crypto";
import { Hono } from "hono";

export const powerRouter = new Hono<AppBindings>();

const MAX_RANGE_S = 400 * 86400;
const MAX_MONTHS = 24;
const DEFAULT_MONTHS = 12;

function unixSeconds(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/** The `tz` query param, `UTC` when absent; null when it is not a time zone. */
function timeZone(value: string | undefined): string | null {
  const tz = value ?? "UTC";
  return isValidTimeZone(tz) ? tz : null;
}

const TZ_ERROR = "tz must be an IANA time zone";

// GET /api/power?from=&to=&tz= — totals, daily breakdown, projection, idle floor.
powerRouter.get("/", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const from = unixSeconds(c.req.query("from"));
  const to = unixSeconds(c.req.query("to"));
  if (from === null || to === null) {
    return c.json({ error: "from and to must be unix seconds" }, 400);
  }
  if (from >= to) return c.json({ error: "from must be before to" }, 400);
  if (to - from > MAX_RANGE_S) {
    return c.json({ error: "range must be at most 400 days" }, 400);
  }
  const tz = timeZone(c.req.query("tz"));
  if (tz === null) return c.json({ error: TZ_ERROR }, 400);

  const now = nowSeconds();
  const data = await loadPowerData(c.env, orgId, dayPeriods(from, to, tz), now);
  const { totals, periods } = summarize(
    data.periods,
    data.dataStart,
    now,
    data.settings,
  );
  return c.json({
    from,
    to,
    tz,
    dataStart: data.dataStart,
    settings: data.settings,
    cloudRates: data.cloudRates,
    totals,
    days: periods,
    projectionUsd:
      to > now
        ? projectUsd(totals, to - Math.max(now, from), data.settings)
        : null,
    idleFloor: idleFloor(data.idleP10W, data.settings),
  });
});

// GET /api/power/months?count=&tz= — the last `count` calendar months.
powerRouter.get("/months", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const rawCount = c.req.query("count");
  const count = rawCount === undefined ? DEFAULT_MONTHS : unixSeconds(rawCount);
  if (count === null || count < 1 || count > MAX_MONTHS) {
    return c.json(
      { error: `count must be an integer from 1 to ${MAX_MONTHS}` },
      400,
    );
  }
  const tz = timeZone(c.req.query("tz"));
  if (tz === null) return c.json({ error: TZ_ERROR }, 400);

  const now = nowSeconds();
  const data = await loadPowerData(
    c.env,
    orgId,
    monthPeriods(count, now, tz),
    now,
  );
  return c.json({
    tz,
    dataStart: data.dataStart,
    settings: data.settings,
    cloudRates: data.cloudRates,
    // Each month on its own, so its gaps are filled from its own average.
    months: data.periods.map((p) => ({
      start: p.start,
      end: p.end,
      ...summarize([p], data.dataStart, now, data.settings).totals,
    })),
  });
});

// GET /api/power/settings — the org's power cost settings.
powerRouter.get("/settings", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const settings = await new TenantService(c.env.DB).getSettings(orgId);
  return c.json({ power: settings.power ?? {} });
});

// PUT /api/power/settings — update them (owner/admin). `null` clears a field.
powerRouter.put("/settings", requireAdmin(), async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: "Invalid JSON body" }, 400);
  const patch = parsePowerSettings(body);
  if ("error" in patch) return c.json({ error: patch.error }, 400);

  const tenants = new TenantService(c.env.DB);
  const current = await tenants.getSettings(orgId);
  const power = applyPowerPatch(current.power ?? {}, patch);
  await tenants.updateSettings(orgId, { power });
  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "update",
    resourceType: "tenant",
    resourceId: orgId,
    details: { power },
  });
  return c.json({ power });
});
