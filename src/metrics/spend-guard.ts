import { TenantService } from "../db/tenant";
import type { ApiKeyScopes } from "../types";
import { nowSeconds } from "../utils/crypto";
import { monthStartSeconds, spendForRange } from "./cost-tracker";

const KEY_CAP_DISABLE_SLACK = 365 * 24 * 3600;

export interface SpendBlock {
  reason: string;
  kind: "tenant_daily" | "tenant_monthly" | "key_cap";
  disabledUntil: number;
}

/**
 * Fast pre-request check: is this tenant/key currently auto-disabled by a
 * spend limit? Reads only the persisted flags — no aggregation at request time.
 */
export async function spendBlockReason(
  env: Env,
  organizationId: string,
  keySpendDisabledUntil?: number | null,
): Promise<SpendBlock | null> {
  const now = nowSeconds();

  if (keySpendDisabledUntil && now < keySpendDisabledUntil) {
    return {
      reason: "API key spend cap reached",
      kind: "key_cap",
      disabledUntil: keySpendDisabledUntil,
    };
  }

  const tenants = new TenantService(env.DB);
  const settings = await tenants.getSettings(organizationId);
  const tenantDisabledUntil = settings.spendDisabledUntil as number | undefined;
  if (tenantDisabledUntil && now < tenantDisabledUntil) {
    return {
      reason: "Tenant spend limit reached",
      kind: "tenant_daily",
      disabledUntil: tenantDisabledUntil,
    };
  }

  return null;
}

function endOfDaySeconds(now: number): number {
  return now - (now % 86400) + 86400;
}

function endOfMonthSeconds(now: number): number {
  const d = new Date(now * 1000);
  const endOfMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  );
  return Math.floor(endOfMonth.getTime() / 1000);
}

/**
 * Post-request check (called from waitUntil): if a tenant window limit or the
 * key's lifetime spend cap was just crossed, persist the disable flag. The
 * flag self-expires at the end of the affected window.
 */
export async function maybeDisableAfterSpend(
  env: Env,
  organizationId: string,
  apiKeyId: string,
  scopes: ApiKeyScopes,
): Promise<void> {
  const now = nowSeconds();
  const tenants = new TenantService(env.DB);
  const settings = await tenants.getSettings(organizationId);
  const limits = settings.spendLimits;
  let disabledUntil = settings.spendDisabledUntil as number | undefined;

  if (limits?.dailyUsd) {
    const spent = await spendForRange(env, organizationId, {
      start: endOfDaySeconds(now) - 86400,
      end: endOfDaySeconds(now),
    });
    if (spent.costUsd >= limits.dailyUsd) {
      disabledUntil = Math.max(disabledUntil ?? 0, endOfDaySeconds(now));
    }
  }
  if (limits?.monthlyUsd) {
    const spent = await spendForRange(env, organizationId, {
      start: monthStartSeconds(now),
      end: endOfMonthSeconds(now),
    });
    if (spent.costUsd >= limits.monthlyUsd) {
      disabledUntil = Math.max(disabledUntil ?? 0, endOfMonthSeconds(now));
    }
  }

  if (disabledUntil && now < disabledUntil) {
    await tenants.updateSettings(organizationId, {
      spendDisabledUntil: disabledUntil,
    });
  }

  if (scopes.spendCapUsd !== undefined && scopes.spendCapUsd > 0) {
    const spent = await spendForRange(env, organizationId, {
      start: 0,
      end: now,
    });
    if (spent.costUsd >= scopes.spendCapUsd) {
      await env.DB.prepare(
        "UPDATE api_keys SET spend_disabled_until = ? WHERE id = ?",
      )
        .bind(now + KEY_CAP_DISABLE_SLACK, apiKeyId)
        .run();
    }
  }
}

/**
 * Re-evaluate a tenant's disable flag after limits changed (called by the
 * limits API): clears the flag when spend is back under all limits, otherwise
 * pins it to the latest crossed window end.
 */
export async function reconcileTenantDisable(
  env: Env,
  organizationId: string,
): Promise<void> {
  const tenants = new TenantService(env.DB);
  const now = nowSeconds();
  const settings = await tenants.getSettings(organizationId);
  const limits = settings.spendLimits;
  let disabledUntil: number | undefined;

  if (limits?.dailyUsd) {
    const spent = await spendForRange(env, organizationId, {
      start: endOfDaySeconds(now) - 86400,
      end: endOfDaySeconds(now),
    });
    if (spent.costUsd >= limits.dailyUsd) disabledUntil = endOfDaySeconds(now);
  }
  if (limits?.monthlyUsd) {
    const spent = await spendForRange(env, organizationId, {
      start: monthStartSeconds(now),
      end: endOfMonthSeconds(now),
    });
    if (spent.costUsd >= limits.monthlyUsd) {
      disabledUntil = Math.max(disabledUntil ?? 0, endOfMonthSeconds(now));
    }
  }

  if (disabledUntil !== undefined) {
    await tenants.updateSettings(organizationId, {
      spendDisabledUntil: disabledUntil,
    });
  } else {
    await tenants.updateSettings(organizationId, {
      spendDisabledUntil: null,
    });
  }
}

/**
 * Re-evaluate a key's disable flag after scopes changed (called by the keys
 * API): clears the flag when the raised cap is above lifetime spend.
 */
export async function reconcileKeyDisable(
  env: Env,
  organizationId: string,
  apiKeyId: string,
  spendCapUsd: number | undefined,
): Promise<void> {
  if (!spendCapUsd || spendCapUsd <= 0) {
    await env.DB.prepare(
      "UPDATE api_keys SET spend_disabled_until = NULL WHERE id = ?",
    )
      .bind(apiKeyId)
      .run();
    return;
  }
  const spent = await spendForRange(env, organizationId, {
    start: 0,
    end: nowSeconds(),
  });
  if (spent.costUsd < spendCapUsd) {
    await env.DB.prepare(
      "UPDATE api_keys SET spend_disabled_until = NULL WHERE id = ?",
    )
      .bind(apiKeyId)
      .run();
  }
}
