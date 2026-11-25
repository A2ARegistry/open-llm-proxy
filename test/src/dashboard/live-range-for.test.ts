import { smallestLivePreset } from "../../../dashboard/src/lib/liveRangeFor";
import { describe, expect, it } from "vitest";

const NOW = 1_800_000_000_000;
const ago = (s: number) => NOW / 1000 - s;

describe("smallestLivePreset", () => {
  it("picks the smallest preset containing the request", () => {
    expect(smallestLivePreset(ago(30 * 60), NOW)).toBe("1h");
    expect(smallestLivePreset(ago(3 * 3600), NOW)).toBe("6h");
    expect(smallestLivePreset(ago(10 * 3600), NOW)).toBe("24h");
    expect(smallestLivePreset(ago(2 * 86400), NOW)).toBe("7d");
    expect(smallestLivePreset(ago(20 * 86400), NOW)).toBe("30d");
    expect(smallestLivePreset(ago(60 * 86400), NOW)).toBe("90d");
    expect(smallestLivePreset(ago(200 * 86400), NOW)).toBe("1y");
  });

  it("caps at 1y for older requests", () => {
    expect(smallestLivePreset(ago(2 * 365 * 86400), NOW)).toBe("1y");
  });

  it("treats exact boundaries and future timestamps as inside", () => {
    expect(smallestLivePreset(ago(3600), NOW)).toBe("1h");
    expect(smallestLivePreset(ago(-60), NOW)).toBe("1h");
  });
});
