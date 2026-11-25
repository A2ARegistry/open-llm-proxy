// [fork] W13: the org's power cost settings (tenant setting `power`).

/** Cloud prices the box's tokens are compared against, in USD per 1M tokens. */
export interface CloudReference {
  label?: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheWritePer1m: number;
}

export interface PowerSettings {
  pricePerKwhUsd?: number;
  overheadW?: number;
  cloudReference?: CloudReference;
}

/** A settings update: a field set to `null` is cleared, a missing one is kept. */
export type PowerSettingsPatch = {
  [K in keyof PowerSettings]?: PowerSettings[K] | null;
};

const MAX_OVERHEAD_W = 500;
const MAX_LABEL = 80;
const RATES = [
  "inputPer1m",
  "outputPer1m",
  "cacheReadPer1m",
  "cacheWritePer1m",
] as const;

const isNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseReference(value: unknown): CloudReference | string {
  if (typeof value !== "object" || value === null) {
    return "cloudReference must be an object or null";
  }
  const raw = value as Record<string, unknown>;
  const ref = {} as CloudReference;
  for (const key of RATES) {
    if (!isNonNegative(raw[key])) {
      return `cloudReference.${key} must be a non-negative number`;
    }
    ref[key] = raw[key];
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || raw.label.length > MAX_LABEL) {
      return `cloudReference.label must be a string of at most ${MAX_LABEL} characters`;
    }
    ref.label = raw.label;
  }
  return ref;
}

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
  if (raw.cloudReference !== undefined) {
    if (raw.cloudReference === null) {
      patch.cloudReference = null;
    } else {
      const ref = parseReference(raw.cloudReference);
      if (typeof ref === "string") return { error: ref };
      patch.cloudReference = ref;
    }
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
