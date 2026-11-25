// [fork] W13: Settings page "Power cost" form <-> API settings.
import type { PowerSettings, PowerSettingsPatch } from "./powerTypes";

/** Form fields as typed (strings); empty means "not set". */
export interface PowerForm {
  price: string;
  overhead: string;
  label: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

const RATE_FIELDS = [
  ["input", "inputPer1m", "Input"],
  ["output", "outputPer1m", "Output"],
  ["cacheRead", "cacheReadPer1m", "Cache read"],
  ["cacheWrite", "cacheWritePer1m", "Cache write"],
] as const;

const text = (v: number | undefined) => (v === undefined ? "" : String(v));

export function toPowerForm(s: PowerSettings): PowerForm {
  const ref = s.cloudReference;
  return {
    price: text(s.pricePerKwhUsd),
    overhead: text(s.overheadW),
    label: ref?.label ?? "",
    input: text(ref?.inputPer1m),
    output: text(ref?.outputPer1m),
    cacheRead: text(ref?.cacheReadPer1m),
    cacheWrite: text(ref?.cacheWritePer1m),
  };
}

/** A non-negative number, `null` for an empty field, or an error message. */
function parseNumber(value: string, name: string): number | null | string {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0
    ? n
    : `${name} must be a non-negative number`;
}

/** Build the PUT body; empty fields clear their setting. */
export function fromPowerForm(
  f: PowerForm,
): PowerSettingsPatch | { error: string } {
  const price = parseNumber(f.price, "Price per kWh");
  if (typeof price === "string") return { error: price };
  const overhead = parseNumber(f.overhead, "Overhead");
  if (typeof overhead === "string") return { error: overhead };

  const label = f.label.trim();
  const rates = RATE_FIELDS.map(([field]) => f[field]);
  if (label === "" && rates.every((r) => r.trim() === "")) {
    return { pricePerKwhUsd: price, overheadW: overhead, cloudReference: null };
  }
  const ref: Record<string, number | string> = {};
  for (const [field, key, name] of RATE_FIELDS) {
    const v = parseNumber(f[field], `${name} price`);
    if (typeof v === "string") return { error: v };
    if (v === null) {
      return { error: "Fill in all four cloud prices, or none of them" };
    }
    ref[key] = v;
  }
  if (label !== "") ref.label = label;
  return {
    pricePerKwhUsd: price,
    overheadW: overhead,
    cloudReference: ref as unknown as PowerSettings["cloudReference"],
  };
}
