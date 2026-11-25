// [fork] W12: sampler alarm cadence.
import { describe, expect, it } from "vitest";
import { nextAlarmAt } from "~/src/live/alarm-schedule";

describe("nextAlarmAt", () => {
  it("keeps cadence when on time", () => {
    expect(nextAlarmAt(10_000, 10_400)).toBe(20_000);
  });

  it("jumps to the next boundary after now when behind", () => {
    expect(nextAlarmAt(10_000, 45_000)).toBe(50_000);
  });

  it("moves on when exactly on the next boundary", () => {
    expect(nextAlarmAt(10_000, 20_000)).toBe(30_000);
  });
});
