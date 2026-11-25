// [fork] Live page RAM split: processes, model files kept in RAM, free.
import { ramBreakdown } from "../../../dashboard/src/lib/ramBreakdown";
import { describe, expect, it } from "vitest";

const host = {
  memTotalBytes: 1000,
  memAvailableBytes: 400,
  memMappedBytes: 300,
};

describe("ramBreakdown", () => {
  it("splits total into processes, model files and free", () => {
    expect(ramBreakdown(host)).toEqual({
      totalBytes: 1000,
      processesBytes: 600,
      modelFilesBytes: 300,
      freeBytes: 100,
      inUseBytes: 900,
      inUsePercent: 90,
    });
  });

  it("counts mapped bytes only up to what is available", () => {
    const r = ramBreakdown({ ...host, memMappedBytes: 500 })!;
    expect(r.modelFilesBytes).toBe(400);
    expect(r.freeBytes).toBe(0);
    expect(r.inUsePercent).toBe(100);
  });

  it("returns null when a figure is missing or total is zero", () => {
    expect(ramBreakdown({ ...host, memTotalBytes: null })).toBeNull();
    expect(ramBreakdown({ ...host, memAvailableBytes: null })).toBeNull();
    expect(ramBreakdown({ ...host, memMappedBytes: null })).toBeNull();
    expect(ramBreakdown({ ...host, memTotalBytes: 0 })).toBeNull();
  });
});
