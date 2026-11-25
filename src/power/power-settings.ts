// [fork] W13: the org's power cost settings (tenant setting `power`).

export interface PowerSettings {
  pricePerKwhUsd?: number;
  overheadW?: number;
}

/** A settings update: a field set to `null` is cleared, a missing one is kept. */
export type PowerSettingsPatch = {
  [K in keyof PowerSettings]?: PowerSettings[K] | null;
};

const MAX_OVERHEAD_W = 500;

const isNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Validate a settings update from a request body. */
export function parsePowerSettings(
  body: unknown,
): PowerSettingsPatch | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "Body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const patch: PowerSettingsPatch = {};

  if (raw.pricePerKwhUsd !== undefined) {
    if (raw.pricePerKwhUsd !== null && !isNonNegative(raw.pricePerKwhUsd)) {
      return { error: "pricePerKwhUsd must be a non-negative number or null" };
    }
    patch.pricePerKwhUsd = raw.pricePerKwhUsd;
  }
  if (raw.overheadW !== undefined) {
    const v = raw.overheadW;
    if (v !== null && (!isNonNegative(v) || v > MAX_OVERHEAD_W)) {
      return {
        error: `overheadW must be a number from 0 to ${MAX_OVERHEAD_W} or null`,
      };
    }
    patch.overheadW = v;
  }
  return patch;
}

/** Apply a validated patch: `null` removes the field. */
export function applyPowerPatch(
  current: PowerSettings,
  patch: PowerSettingsPatch,
): PowerSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as PowerSettings;
}
