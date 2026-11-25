// [fork] W13: calendar periods in a viewer's time zone.
import { describe, expect, it } from "vitest";
import {
  dayPeriods,
  formatterCacheSize,
  isValidTimeZone,
  monthPeriods,
  startOfMonth,
} from "~/src/power/periods";

const utc = (...args: [number, number, number, number?]) =>
  Date.UTC(...args) / 1000;

describe("dayPeriods", () => {
  it("UTC days clip to range", () => {
    // 2026-11-24T12:00Z → 2026-11-26T06:00Z
    expect(dayPeriods(1795521600, 1795672800, "UTC")).toEqual([
      { start: 1795521600, end: 1795564800 },
      { start: 1795564800, end: 1795651200 },
      { start: 1795651200, end: 1795672800 },
    ]);
  });

  it("Europe/Lisbon DST day is 23 h", () => {
    const [d] = dayPeriods(
      utc(2026, 2, 29),
      utc(2026, 2, 30) - 3600,
      "Europe/Lisbon",
    );
    expect(d.end - d.start).toBe(23 * 3600);
  });

  it("follows local midnight in a positive offset zone", () => {
    // Madrid is UTC+1 in November: local midnight is 23:00Z the day before.
    const days = dayPeriods(
      utc(2026, 10, 24, 23),
      utc(2026, 10, 25, 23),
      "Europe/Madrid",
    );
    expect(days).toEqual([
      { start: utc(2026, 10, 24, 23), end: utc(2026, 10, 25, 23) },
    ]);
  });

  it("empty range gives no periods", () => {
    expect(dayPeriods(100, 100, "UTC")).toEqual([]);
  });
});

describe("monthPeriods", () => {
  it("gives 12 local months ending with the current one", () => {
    const ms = monthPeriods(12, utc(2026, 10, 25), "UTC");
    expect(ms).toHaveLength(12);
    expect(ms[11]).toEqual({ start: utc(2026, 10, 1), end: utc(2026, 11, 1) });
    expect(ms[0].start).toBe(utc(2025, 11, 1));
  });

  it("uses local month boundaries", () => {
    const [m] = monthPeriods(1, utc(2026, 10, 25), "Europe/Madrid");
    expect(m).toEqual({
      start: utc(2026, 9, 31, 23),
      end: utc(2026, 10, 30, 23),
    });
  });
});

describe("startOfMonth", () => {
  it("in Lisbon summer time", () => {
    expect(startOfMonth(utc(2026, 6, 15), "Europe/Lisbon")).toBe(
      utc(2026, 5, 30, 23),
    );
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects others", () => {
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});

describe("formatter cache", () => {
  it("stays bounded for many spellings of a zone", () => {
    // Zone names are case-insensitive, so a caller can send endless variants.
    const variants = Array.from({ length: 200 }, (_, i) =>
      "europe/madrid"
        .split("")
        .map((ch, j) => ((i >> j) & 1 ? ch.toUpperCase() : ch))
        .join(""),
    );
    for (const tz of variants) expect(isValidTimeZone(tz)).toBe(true);
    expect(formatterCacheSize()).toBeLessThanOrEqual(64);
    expect(dayPeriods(0, 86400, variants[199])).toHaveLength(2);
  });
});
