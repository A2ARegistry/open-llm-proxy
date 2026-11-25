// [fork] W13: energy, cost and cloud-comparison maths.
import { describe, expect, it } from "vitest";
import type { PowerSettings } from "~/src/power/power-settings";
import {
  effectiveSeconds,
  idleFloor,
  projectUsd,
  summarize,
  type PeriodRaw,
} from "~/src/power/power-summary";

const settings: PowerSettings = { pricePerKwhUsd: 0.2, overheadW: 10 };
const tokens = {
  input: 3_000_000,
  output: 1_000_000,
  cacheRead: 1_000_000,
  cacheWrite: 0,
  requests: 5,
};
const noTokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
};
// 1 h range, 30 min measured at 20 W avg
const raw: PeriodRaw[] = [
  {
    start: 0,
    end: 3600,
    measuredWs: 20 * 1800,
    measuredS: 1800,
    peakW: 60,
    tokens,
    // 3M in at $1, 1M out at $4, 1M cache read at $0.1 (priced in SQL)
    cloudUsd: 7.1,
    unpricedRequests: 0,
  },
];

describe("summarize", () => {
  it("full maths", () => {
    const { totals, periods } = summarize(raw, 0, 10_000, settings);
    expect(totals.coverage).toBe(0.5);
    expect(totals.avgW).toBe(20);
    expect(totals.measuredKwh).toBeCloseTo(0.01);
    expect(totals.estimatedKwh).toBeCloseTo(0.01);
    expect(totals.overheadKwh).toBeCloseTo(0.01);
    expect(totals.totalKwh).toBeCloseTo(0.03);
    expect(totals.electricityUsd).toBeCloseTo(0.006);
    expect(totals.cloudUsd).toBeCloseTo(7.1);
    expect(totals.unpricedRequests).toBe(0);
    expect(totals.savingsUsd).toBeCloseTo(7.1 - 0.006);
    expect(totals.peakW).toBe(60);
    expect(totals.electricityPer1mOutputUsd).toBeCloseTo(0.006);
    expect(totals.cloudPer1mOutputUsd).toBeCloseTo(7.1);
    expect(periods[0]).toMatchObject({ start: 0, end: 3600, coverage: 0.5 });
  });

  it("fills each period's gaps with the range average so periods add up", () => {
    const two: PeriodRaw[] = [
      {
        start: 0,
        end: 100,
        measuredWs: 1000,
        measuredS: 100,
        peakW: 10,
        tokens: noTokens,
        cloudUsd: 0,
        unpricedRequests: 0,
      },
      {
        start: 100,
        end: 200,
        measuredWs: 1500,
        measuredS: 50,
        peakW: 40,
        tokens: noTokens,
        cloudUsd: 0,
        unpricedRequests: 0,
      },
    ];
    const { totals, periods } = summarize(two, 0, 10_000, {});
    // range average 2500 Ws / 150 s; second period's 50 s gap uses it
    expect(periods[1].estimatedKwh).toBeCloseTo((50 * 2500) / 150 / 3.6e6);
    expect(periods[1].avgW).toBe(30);
    expect(periods[0].estimatedKwh + periods[1].estimatedKwh).toBeCloseTo(
      totals.estimatedKwh,
    );
    expect(totals.peakW).toBe(40);
  });

  it("keeps the peak when a later period has none", () => {
    const two: PeriodRaw[] = [
      { ...raw[0], end: 1800 },
      { ...raw[0], start: 1800, measuredS: 0, measuredWs: 0, peakW: null },
    ];
    expect(summarize(two, 0, 10_000, {}).totals.peakW).toBe(60);
  });

  it("projects without an overhead", () => {
    const s = { pricePerKwhUsd: 0.2 };
    const { totals } = summarize(raw, 0, 3600, s);
    expect(projectUsd(totals, 3600, s)).toBeCloseTo(
      totals.electricityUsd! + ((20 * 3600) / 3.6e6) * 0.2,
    );
  });

  it("null electricity money without a kWh price", () => {
    const { totals } = summarize(raw, 0, 10_000, {});
    expect(totals.totalKwh).toBeGreaterThan(0);
    expect(totals.overheadKwh).toBe(0);
    expect([
      totals.electricityUsd,
      totals.savingsUsd,
      totals.electricityPer1mOutputUsd,
    ]).toEqual([null, null, null]);
    expect(totals.cloudUsd).toBeCloseTo(7.1);
  });

  it("no cloud figure when every request is unpriced", () => {
    const { totals } = summarize(
      [{ ...raw[0], cloudUsd: 0, unpricedRequests: tokens.requests }],
      0,
      10_000,
      settings,
    );
    expect(totals.cloudUsd).toBeNull();
    expect(totals.savingsUsd).toBeNull();
    expect(totals.cloudPer1mOutputUsd).toBeNull();
    expect(totals.unpricedRequests).toBe(tokens.requests);
  });

  it("partly priced keeps the priced figure and counts the rest", () => {
    const two: PeriodRaw[] = [
      { ...raw[0], end: 1800 },
      {
        ...raw[0],
        start: 1800,
        cloudUsd: 0,
        unpricedRequests: tokens.requests,
      },
    ];
    const { totals, periods } = summarize(two, 0, 10_000, settings);
    expect(totals.cloudUsd).toBeCloseTo(7.1);
    expect(totals.unpricedRequests).toBe(tokens.requests);
    expect(periods[1].cloudUsd).toBeNull();
  });

  it("no measured seconds gives no estimate", () => {
    const { totals } = summarize(
      [{ ...raw[0], measuredWs: 0, measuredS: 0, peakW: null }],
      0,
      10_000,
      settings,
    );
    expect([
      totals.avgW,
      totals.estimatedKwh,
      totals.coverage,
      totals.peakW,
    ]).toEqual([null, 0, 0, null]);
  });

  it("no output tokens gives no per-1M figures", () => {
    const { totals } = summarize(
      [{ ...raw[0], tokens: noTokens, cloudUsd: 0 }],
      0,
      10_000,
      settings,
    );
    expect(totals.cloudUsd).toBe(0);
    expect(totals.electricityPer1mOutputUsd).toBeNull();
    expect(totals.cloudPer1mOutputUsd).toBeNull();
  });

  it("period before data start is no power data", () => {
    const { totals, periods } = summarize(raw, 5000, 10_000, settings);
    expect(periods[0]).toMatchObject({
      effectiveS: 0,
      coverage: null,
      avgW: null,
      electricityUsd: null,
      cloudUsd: null,
      totalKwh: 0,
      tokens: noTokens,
    });
    expect(totals.effectiveS).toBe(0);
    expect(totals.electricityUsd).toBeNull();
  });

  it("no data start at all is no power data", () => {
    expect(summarize(raw, null, 10_000, settings).totals.coverage).toBeNull();
  });
});

describe("effectiveSeconds", () => {
  it("clips periods to data start", () => {
    expect(effectiveSeconds({ start: 0, end: 3600 }, 1800, 10_000)).toBe(1800);
    expect(effectiveSeconds({ start: 0, end: 3600 }, null, 10_000)).toBe(0);
    expect(effectiveSeconds({ start: 0, end: 3600 }, 0, 600)).toBe(600);
    expect(effectiveSeconds({ start: 0, end: 3600 }, 5000, 10_000)).toBe(0);
  });
});

describe("idleFloor and projection", () => {
  it("idleFloor", () => {
    expect(idleFloor(7, settings)).toEqual({
      watts: 17,
      monthlyUsd: ((17 * 730) / 1000) * 0.2,
    });
    expect(idleFloor(7, {})).toEqual({ watts: 7, monthlyUsd: null });
    expect(idleFloor(null, settings)).toBeNull();
  });

  it("projectUsd", () => {
    const { totals } = summarize(raw, 0, 3600, settings);
    expect(projectUsd(totals, 3600, settings)).toBeCloseTo(
      totals.electricityUsd! + ((30 * 3600) / 3.6e6) * 0.2,
    );
    expect(projectUsd(totals, 3600, {})).toBeNull();
    const empty = summarize(raw, null, 3600, settings).totals;
    expect(projectUsd(empty, 3600, settings)).toBeNull();
  });
});
