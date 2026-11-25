// [fork] W13: Settings page "Power cost" form <-> API settings.
import type { PowerSettings, PowerSettingsPatch } from "./powerTypes";

/** Form fields as typed (strings); empty means "not set". */
export interface PowerForm {
  price: string;
  overhead: string;
}

const text = (v: number | undefined) => (v === undefined ? "" : String(v));

export function toPowerForm(s: PowerSettings): PowerForm {
  return { price: text(s.pricePerKwhUsd), overhead: text(s.overheadW) };
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
  return { pricePerKwhUsd: price, overheadW: overhead };
}
