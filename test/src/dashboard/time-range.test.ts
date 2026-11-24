import {
  fillBuckets,
  parseRange,
  rangeOption,
  rangeWindow,
} from "../../../dashboard/src/lib/timeRange";
import { describe, expect, it } from "vitest";

describe("parseRange", () => {
  it("accepts allowed values and falls back otherwise", () => {
    expect(parseRange("7d", ["7d", "30d"], "30d")).toBe("7d");
    expect(parseRange("1h", ["7d", "30d"], "30d")).toBe("30d");
    expect(parseRange(null, ["7d"], "7d")).toBe("7d");
  });
});

describe("rangeWindow", () => {
  it("ends just after now and spans the preset", () => {
    expect(rangeWindow("1h", 10_000_500)).toEqual({
      start: 10_001 - 3600,
      end: 10_001,
    });
    expect(rangeOption("90d").seconds).toBe(90 * 86400);
  });
});

describe("fillBuckets", () => {
  it("fills gaps from the bucket containing start up to end", () => {
    const points = [{ t: 7200, n: 2 }];
    expect(
      fillBuckets(points, 3700, 10_800, 3600, (t) => ({ t, n: 0 })),
    ).toEqual([
      { t: 3600, n: 0 },
      { t: 7200, n: 2 },
    ]);
  });
});
