// [fork] W11: live page series math (rates from counter deltas).
import type {
  HostSnapshot,
  InferenceSnapshot,
  LiveSnapshot,
} from "../../../dashboard/src/lib/api";
import {
  LIVE_HISTORY_POINTS,
  LIVE_POLL_MS,
  appendPoint,
  ratio,
  toPoint,
  type LivePoint,
} from "../../../dashboard/src/lib/liveSeries";
import { describe, expect, it } from "vitest";

function inference(over: Partial<InferenceSnapshot> = {}): InferenceSnapshot {
  return {
    binding: "HALOGEN",
    version: "1.0.0",
    slots: 3,
    inFlight: 1,
    queued: 0,
    longestWaitS: 0,
    kvUsageRatio: 0.5,
    kvPoolPositions: 1000,
    kvReservedTokens: 10,
    predictedTokensTotal: 1000,
    promptTokensTotal: 5000,
    cacheHitsTotal: 3,
    cacheMissesTotal: 1,
    cacheTokensSavedTotal: 100,
    draftTokensTotal: 10,
    draftAcceptedTotal: 8,
    ...over,
  };
}

function host(over: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    binding: "BOXSTATS",
    cpuIdleSecondsTotal: 100,
    cpuSecondsTotal: 200,
    memTotalBytes: 128,
    memAvailableBytes: 64,
    gpuBusyPercent: 90,
    gpuMemUsedBytes: 10,
    gpuMemTotalBytes: 100,
    cpuTempC: 70,
    gpuTempC: 75,
    ssdTempC: 50,
    gpuPowerW: 80,
    ...over,
  };
}

function snap(
  at: number,
  inf: Partial<InferenceSnapshot> | null = {},
  h: Partial<HostSnapshot> | null = {},
): LiveSnapshot {
  return {
    at,
    inference: inf === null ? null : inference(inf),
    host: h === null ? null : host(h),
    lastRequest: null,
  };
}

describe("toPoint", () => {
  it("decode tok/s from counter delta", () => {
    const p = toPoint(
      snap(0, { predictedTokensTotal: 1000, promptTokensTotal: 5000 }),
      snap(2000, { predictedTokensTotal: 1040, promptTokensTotal: 7000 }),
    );
    expect(p.t).toBe(2000);
    expect(p.decodeTps).toBe(20);
    expect(p.prefillTps).toBe(1000);
  });

  it("counter reset gives a gap", () => {
    const p = toPoint(
      snap(0, { predictedTokensTotal: 1000 }),
      snap(2000, { predictedTokensTotal: 50 }),
    );
    expect(p.decodeTps).toBeNull();
  });

  it("no time elapsed gives a gap", () => {
    expect(toPoint(snap(2000), snap(2000)).decodeTps).toBeNull();
  });

  it("first point has no rates", () => {
    const p = toPoint(null, snap(2000));
    expect(p.decodeTps).toBeNull();
    expect(p.prefillTps).toBeNull();
    expect(p.cpuPercent).toBeNull();
    expect(p.gpuBusyPercent).toBe(90);
    expect(p.gpuTempC).toBe(75);
    expect(p.gpuPowerW).toBe(80);
  });

  it("cpu percent from idle/total deltas", () => {
    const p = toPoint(
      snap(0, {}, { cpuIdleSecondsTotal: 100, cpuSecondsTotal: 200 }),
      snap(2000, {}, { cpuIdleSecondsTotal: 106, cpuSecondsTotal: 208 }),
    );
    expect(p.cpuPercent).toBe(25);
  });

  it("null source gives null fields", () => {
    const p = toPoint(snap(0, null, null), snap(2000, null, null));
    expect(p.decodeTps).toBeNull();
    expect(p.cpuPercent).toBeNull();
    expect(p.cpuTempC).toBeNull();
    expect(p.ssdTempC).toBeNull();
    expect(p.gpuBusyPercent).toBeNull();
  });
});

describe("appendPoint", () => {
  it("caps at 300", () => {
    let points: LivePoint[] = [];
    for (let i = 0; i < 305; i++)
      points = appendPoint(points, toPoint(null, snap(i)));
    expect(points).toHaveLength(LIVE_HISTORY_POINTS);
    expect(LIVE_HISTORY_POINTS).toBe(300);
    expect(points[0].t).toBe(5);
    expect(LIVE_POLL_MS).toBe(2000);
  });
});

describe("ratio", () => {
  it("divides hits by the total, null without data", () => {
    expect(ratio(3, 4)).toBe(0.75);
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(null, 4)).toBeNull();
    expect(ratio(3, null)).toBeNull();
  });
});
