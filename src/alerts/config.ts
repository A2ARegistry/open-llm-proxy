import type { TenantSettings } from "../db/tenant";
import { TenantService } from "../db/tenant";

export interface AlertSettings {
  enabled: boolean;
  emailEnabled: boolean;
  errorThresholdPct: number;
  errorMinRequests: number;
  errorWindowMinutes: number;
  cooldownMinutes: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  emailEnabled: true,
  errorThresholdPct: 5,
  errorMinRequests: 20,
  errorWindowMinutes: 30,
  cooldownMinutes: 60,
};

const VALID_KEYS = new Set<keyof AlertSettings>([
  "enabled",
  "emailEnabled",
  "errorThresholdPct",
  "errorMinRequests",
  "errorWindowMinutes",
  "cooldownMinutes",
]);

/** Merge the tenant's stored `alerts` settings with defaults. */
export function loadAlertSettings(settings: TenantSettings): AlertSettings {
  const stored = (settings.alerts ?? {}) as Partial<AlertSettings>;
  const next = { ...DEFAULT_ALERT_SETTINGS };
  for (const key of VALID_KEYS) {
    const value = stored[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/**
 * Validate a client-supplied alerts config patch. Returns the normalized
 * patch or a string error message.
 */
export function validateAlertPatch(
  body: Record<string, unknown>,
): Partial<AlertSettings> | string {
  const patch: Partial<AlertSettings> = {};
  for (const key of VALID_KEYS) {
    if (body[key] === undefined) continue;
    const value = body[key];
    if (key === "enabled" || key === "emailEnabled") {
      if (typeof value !== "boolean") return `${key} must be a boolean`;
      patch[key] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return `${key} must be a positive number`;
    }
    const max: Record<string, number> = {
      errorThresholdPct: 100,
      errorMinRequests: 100000,
      errorWindowMinutes: 1440,
      cooldownMinutes: 10080,
    };
    if (value > max[key]) return `${key} is too large`;
    patch[key] = Math.round(value);
  }
  return patch;
}

/** Persist an alerts settings patch for a tenant. */
export async function saveAlertSettings(
  env: Env,
  organizationId: string,
  patch: Partial<AlertSettings>,
): Promise<AlertSettings> {
  const tenants = new TenantService(env.DB);
  const settings = await tenants.getSettings(organizationId);
  const merged = {
    ...loadAlertSettings(settings),
    ...patch,
  } as TenantSettings["alerts"];
  await tenants.updateSettings(organizationId, { alerts: merged });
  return merged as AlertSettings;
}
