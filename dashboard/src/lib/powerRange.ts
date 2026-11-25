// [fork] W13: Power page ranges, in the browser's local time zone (the same
// zone the page sends to /api/power as `tz`).

export type PowerPreset = "this-month" | "last-month" | "30d" | "90d" | "1y";

export const POWER_PRESETS: { value: PowerPreset; label: string }[] = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "1y", label: "Last year" },
];

const DAY_S = 86400;
const ROLLING_DAYS: Record<string, number> = {
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** `[from, to)` in unix seconds. "This month" ends at month end so the API projects it. */
export function powerRange(
  preset: PowerPreset,
  nowMs: number,
): { from: number; to: number } {
  const now = new Date(nowMs);
  const y = now.getFullYear();
  const m = now.getMonth();
  if (preset === "this-month") {
    return { from: unix(new Date(y, m, 1)), to: unix(new Date(y, m + 1, 1)) };
  }
  if (preset === "last-month") {
    return { from: unix(new Date(y, m - 1, 1)), to: unix(new Date(y, m, 1)) };
  }
  const to = Math.floor(nowMs / 1000);
  return { from: to - ROLLING_DAYS[preset] * DAY_S, to };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole local days from `fromDate` through `toDate` (yyyy-mm-dd); null if invalid. */
export function customRange(
  fromDate: string,
  toDate: string,
): { from: number; to: number } | null {
  const a = DATE.exec(fromDate);
  const b = DATE.exec(toDate);
  if (!a || !b) return null;
  const from = unix(new Date(+a[1], +a[2] - 1, +a[3]));
  const to = unix(new Date(+b[1], +b[2] - 1, +b[3] + 1));
  return from < to ? { from, to } : null;
}
