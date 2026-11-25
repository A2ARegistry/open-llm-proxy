// [fork] W13: Power page ranges (the runtime's local zone; UTC in tests).
import { customRange, powerRange } from "../../../dashboard/src/lib/powerRange";
import { describe, expect, it } from "vitest";

const NOW = Date.UTC(2026, 10, 25, 14, 30); // 2026-11-25 14:30
const s = (...a: [number, number, number]) => Date.UTC(...a) / 1000;

describe("powerRange", () => {
  it("this month runs to the end of the month", () => {
    expect(powerRange("this-month", NOW)).toEqual({
      from: s(2026, 10, 1),
      to: s(2026, 11, 1),
    });
  });

  it("last month is the previous calendar month", () => {
    expect(powerRange("last-month", Date.UTC(2026, 0, 10))).toEqual({
      from: s(2025, 11, 1),
      to: s(2026, 0, 1),
    });
  });

  it("rolling presets end now", () => {
    const now = Math.floor(NOW / 1000);
    expect(powerRange("30d", NOW)).toEqual({ from: now - 30 * 86400, to: now });
    expect(powerRange("90d", NOW)).toEqual({ from: now - 90 * 86400, to: now });
    expect(powerRange("1y", NOW)).toEqual({ from: now - 365 * 86400, to: now });
  });
});

describe("customRange", () => {
  it("covers whole local days, end day included", () => {
    expect(customRange("2026-11-01", "2026-11-03")).toEqual({
      from: s(2026, 10, 1),
      to: s(2026, 10, 4),
    });
  });

  it("rejects empty, reversed or bad dates", () => {
    expect(customRange("", "2026-11-03")).toBeNull();
    expect(customRange("2026-11-05", "2026-11-03")).toBeNull();
    expect(customRange("nope", "2026-11-03")).toBeNull();
  });
});
