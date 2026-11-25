// [fork] W13: calendar periods (local days and months) in an IANA time zone.

/** A half-open time span `[start, end)` in unix seconds. */
export interface Period {
  start: number;
  end: number;
}

interface LocalDate {
  year: number;
  /** 0-based, like `Date.UTC`. */
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const MAX_FORMATTERS = 64;

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    // `tz` comes from the query string and zone names are case-insensitive,
    // so callers can send endless spellings: cap the cache.
    if (formatters.size < MAX_FORMATTERS) formatters.set(tz, f);
  }
  return f;
}

/** Number of cached formatters (for tests). */
export function formatterCacheSize(): number {
  return formatters.size;
}

/** Wall-clock fields of `ts` (unix s) in `tz`. */
function wallClock(ts: number, tz: string): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(ts * 1000)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

/** Seconds `tz` is ahead of UTC at instant `ts`. */
function offsetS(ts: number, tz: string): number {
  const w = wallClock(ts, tz);
  const asUtc =
    Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) / 1000;
  return asUtc - ts;
}

function localDate(ts: number, tz: string): LocalDate {
  const w = wallClock(ts, tz);
  return { year: w.year, month: w.month - 1, day: w.day };
}

/** Unix seconds of local midnight starting `year-month-day` (fields may overflow). */
function localMidnight(
  year: number,
  month: number,
  day: number,
  tz: string,
): number {
  const naive = Date.UTC(year, month, day) / 1000;
  const first = naive - offsetS(naive, tz);
  return naive - offsetS(first, tz);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Local days overlapping `[from, to)`, the first and last clipped to it. */
export function dayPeriods(from: number, to: number, tz: string): Period[] {
  const periods: Period[] = [];
  if (from >= to) return periods;
  const { year, month, day } = localDate(from, tz);
  let start = localMidnight(year, month, day, tz);
  for (let i = 1; start < to; i++) {
    const end = localMidnight(year, month, day + i, tz);
    periods.push({ start: Math.max(start, from), end: Math.min(end, to) });
    start = end;
  }
  return periods;
}

/** Local midnight of the first day of the month containing `ts`. */
export function startOfMonth(ts: number, tz: string): number {
  const { year, month } = localDate(ts, tz);
  return localMidnight(year, month, 1, tz);
}

/** The last `count` calendar months ending with the one containing `now`, oldest first. */
export function monthPeriods(count: number, now: number, tz: string): Period[] {
  const { year, month } = localDate(now, tz);
  const periods: Period[] = [];
  for (let i = count - 1; i >= 0; i--) {
    periods.push({
      start: localMidnight(year, month - i, 1, tz),
      end: localMidnight(year, month - i + 1, 1, tz),
    });
  }
  return periods;
}
