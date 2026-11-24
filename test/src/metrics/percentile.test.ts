import { describe, it, expect } from "vitest";
import { percentile } from "~/src/metrics/percentile";

describe("percentile", () => {
  it("uses the nearest rank of an ascending list", () => {
    const sorted = [10, 20, 30, 40];
    expect(percentile(sorted, 0.5)).toBe(20);
    expect(percentile(sorted, 0.95)).toBe(40);
    expect(percentile(sorted, 0)).toBe(10);
  });

  it("returns 0 for an empty list", () => {
    expect(percentile([], 0.5)).toBe(0);
  });
});
