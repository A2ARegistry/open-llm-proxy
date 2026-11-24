// [fork] Per-request cost: local models cost fractions of a cent per request.
import { describe, expect, it } from "vitest";
import { fmtUsdPrecise } from "../../../dashboard/src/lib/format";

describe("fmtUsdPrecise", () => {
  it.each([
    [null, "—"],
    [undefined, "—"],
    [Number.NaN, "—"],
    [0, "$0"],
    [0.00004, "<$0.0001"],
    [0.0001, "$0.0001"],
    [0.00080655, "$0.00081"],
    [0.0020917, "$0.0021"],
    [0.00999, "$0.01"],
    [0.01, "$0.01"],
    [0.1234, "$0.12"],
    [1234.5, "$1,234.50"],
  ])("formats %j as %j", (value, expected) => {
    expect(fmtUsdPrecise(value as number | null | undefined)).toBe(expected);
  });
});
