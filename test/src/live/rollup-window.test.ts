// [fork] W12: completed 10-minute buckets in the last 2 h.
import { describe, expect, it } from "vitest";
import { rollupWindow } from "~/src/live/rollup-window";

describe("rollupWindow", () => {
  it("covers completed 10-minute buckets in the last 2 hours", () => {
    expect(rollupWindow(10_000)).toEqual({ from: 2400, to: 9600 });
  });

  it("excludes a bucket whose end is within the last 60 s", () => {
    // 9660 - 60 = 9600 -> bucket [9000, 9600) is complete, [9600, 10200) is not.
    expect(rollupWindow(9660).to).toBe(9600);
    expect(rollupWindow(9659).to).toBe(9000);
  });
});
