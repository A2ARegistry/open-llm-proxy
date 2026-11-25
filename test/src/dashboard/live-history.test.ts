import type {
  HostAvg,
  InferenceAvg,
  LiveHistory,
} from "../../../dashboard/src/lib/api";
import {
  LIVE_RANGES,
  historyPoints,
  summarize,
} from "../../../dashboard/src/lib/liveHistory";
import { describe, expect, it } from "vitest";

const inf = (o: Partial<InferenceAvg> = {}): InferenceAvg => ({
  slots: 4,
  version: null,
  in_flight: null,
  queued: 0,
  longest_wait_s: null,
  kv_usage_ratio: null,
  kv_reserved_tokens: null,
  cache_hit_ratio: null,
  cache_saved_tps: null,
  draft_accept_ratio: null,
  ...o,
});
const host = (o: Partial<HostAvg> = {}): HostAvg => ({
  cpu_busy_pct: null,
  mem_used_bytes: null,
  mem_total_bytes: null,
  mem_in_use_bytes: null,
  gpu_busy_pct: null,
  gpu_mem_used_bytes: null,
  gpu_mem_total_bytes: null,
  cpu_temp_c: null,
  gpu_temp_c: null,
  ssd_temp_c: null,
  gpu_power_w: null,
  ...o,
});

function history(over: Partial<LiveHistory> = {}): LiveHistory {
  return {
    from: 1000,
    to: 1030,
    bucketS: 10,
    inference: null,
    host: null,
    throughput: [],
    ...over,
  };
}

describe("LIVE_RANGES", () => {
  it("starts with live and ends with 1y", () => {
    expect(LIVE_RANGES[0]).toBe("live");
    expect(LIVE_RANGES.at(-1)).toBe("1y");
  });
});

describe("historyPoints", () => {
  it("returns all-null points for an empty response", () => {
    const pts = historyPoints(history());
    expect(pts.map((p) => p.t)).toEqual([1_000_000, 1_010_000, 1_020_000]);
    for (const p of pts) {
      expect(Object.entries(p).filter(([k]) => k !== "t")).toSatisfy(
        (e: [string, unknown][]) => e.every(([, v]) => v === null),
      );
    }
  });

  it("merges inference, host and throughput by ts", () => {
    const pts = historyPoints(
      history({
        inference: {
          binding: "i",
          points: [{ ts: 1010, ok: 1, samples: null, avg: inf(), max: {} }],
        },
        host: {
          binding: "h",
          points: [
            {
              ts: 1010,
              ok: 1,
              samples: null,
              avg: host({
                cpu_busy_pct: 42,
                gpu_busy_pct: 7,
                cpu_temp_c: 50,
                gpu_temp_c: 60,
                ssd_temp_c: 40,
                gpu_power_w: 12,
              }),
              max: {},
            },
          ],
        },
        throughput: [
          {
            ts: 1010,
            decodeTps: 0,
            prefillTps: 9,
            decodeTpsMax: null,
            prefillTpsMax: null,
          },
        ],
      }),
    );
    expect(pts[1]).toEqual({
      t: 1_010_000,
      decodeTps: 0,
      prefillTps: 9,
      cpuPercent: 42,
      gpuBusyPercent: 7,
      cpuTempC: 50,
      gpuTempC: 60,
      ssdTempC: 40,
      gpuPowerW: 12,
    });
  });

  it("turns missing buckets into null gaps, keeping throughput zeros", () => {
    const pts = historyPoints(
      history({
        throughput: [
          {
            ts: 1000,
            decodeTps: 0,
            prefillTps: 0,
            decodeTpsMax: null,
            prefillTpsMax: null,
          },
        ],
        host: {
          binding: "h",
          points: [
            {
              ts: 1020,
              ok: 1,
              samples: null,
              avg: host({ cpu_busy_pct: 5 }),
              max: {},
            },
          ],
        },
      }),
    );
    expect(pts[0].decodeTps).toBe(0);
    expect(pts[0].cpuPercent).toBeNull();
    expect(pts[1].decodeTps).toBeNull();
    expect(pts[1].cpuPercent).toBeNull();
    expect(pts[2].cpuPercent).toBe(5);
    expect(pts[2].decodeTps).toBeNull();
  });
});

describe("historyPoints with unaligned throughput", () => {
  it("lines points up on the bucket grid", () => {
    const pts = historyPoints(
      history({
        from: 1003,
        to: 1033,
        throughput: [0, 1, 2].map((i) => ({
          ts: 1003 + 10 * i,
          decodeTps: 5,
          prefillTps: 6,
          decodeTpsMax: null,
          prefillTpsMax: null,
        })),
      }),
    );
    expect(
      pts.filter((p) => p.decodeTps === 5 && p.prefillTps === 6),
    ).toHaveLength(3);
  });
});

describe("summarize", () => {
  it("is all null for an empty response", () => {
    const s = summarize(history());
    expect(Object.values(s).every((v) => v === null)).toBe(true);
  });

  it("prefers max columns for peaks and averages the rest", () => {
    const s = summarize(
      history({
        inference: {
          binding: "i",
          points: [
            {
              ts: 1000,
              ok: 1,
              samples: 60,
              avg: inf({
                queued: 1,
                kv_usage_ratio: 0.2,
                cache_hit_ratio: 0.5,
                draft_accept_ratio: 0.4,
              }),
              max: { queued: 5, kv_usage_ratio: 0.9 },
            },
            {
              ts: 1010,
              ok: 1,
              samples: 60,
              avg: inf({
                queued: 2,
                kv_usage_ratio: 0.4,
                cache_hit_ratio: 0.7,
                draft_accept_ratio: null,
              }),
              max: {},
            },
          ],
        },
        host: {
          binding: "h",
          points: [
            {
              ts: 1000,
              ok: 1,
              samples: 60,
              avg: host({
                cpu_busy_pct: 10,
                gpu_busy_pct: 20,
                gpu_mem_used_bytes: 100,
                cpu_temp_c: 40,
                gpu_temp_c: 50,
              }),
              max: { cpu_busy_pct: 90, gpu_temp_c: 80 },
            },
          ],
        },
        throughput: [
          {
            ts: 1000,
            decodeTps: 10,
            prefillTps: 100,
            decodeTpsMax: 30,
            prefillTpsMax: 500,
          },
          {
            ts: 1010,
            decodeTps: 20,
            prefillTps: 300,
            decodeTpsMax: null,
            prefillTpsMax: null,
          },
        ],
      }),
    );
    expect(s.avgDecodeTps).toBe(15);
    expect(s.peakDecodeTps).toBe(30);
    expect(s.avgPrefillTps).toBe(200);
    expect(s.peakPrefillTps).toBe(500);
    expect(s.peakQueued).toBe(5);
    expect(s.avgKvPct).toBeCloseTo(30);
    expect(s.peakKvPct).toBeCloseTo(90);
    expect(s.avgCacheHitPct).toBeCloseTo(60);
    expect(s.avgDraftPct).toBeCloseTo(40);
    expect(s.peakCpuPct).toBe(90);
    expect(s.peakGpuPct).toBe(20);
    expect(s.peakGpuMemBytes).toBe(100);
    expect(s.peakCpuTempC).toBe(40);
    expect(s.peakGpuTempC).toBe(80);
  });

  it("peak memory shares use max in-use over avg total, per bucket", () => {
    const s = summarize(
      history({
        host: {
          binding: "h",
          points: [
            {
              ts: 1000,
              ok: 1,
              samples: 60,
              avg: host({
                mem_in_use_bytes: 10,
                mem_total_bytes: 100,
                gpu_mem_used_bytes: 20,
                gpu_mem_total_bytes: 200,
              }),
              max: { mem_in_use_bytes: 50, gpu_mem_used_bytes: 150 },
            },
            {
              ts: 1010,
              ok: 1,
              samples: null,
              avg: host({
                mem_in_use_bytes: 60,
                mem_total_bytes: 200,
                gpu_mem_used_bytes: 40,
                gpu_mem_total_bytes: 50,
              }),
              max: {},
            },
            {
              ts: 1020,
              ok: 1,
              samples: null,
              avg: host({ mem_in_use_bytes: 70, gpu_mem_used_bytes: 10 }),
              max: {},
            },
          ],
        },
      }),
    );
    expect(s.peakRamPct).toBeCloseTo(50);
    expect(s.peakRamBytes).toBe(70);
    expect(s.peakGpuMemPct).toBeCloseTo(80);
    expect(s.peakGpuMemBytes).toBe(150);
  });

  it("peak decode falls back to avg without max columns", () => {
    const s = summarize(
      history({
        throughput: [
          {
            ts: 1000,
            decodeTps: 10,
            prefillTps: 0,
            decodeTpsMax: null,
            prefillTpsMax: null,
          },
          {
            ts: 1010,
            decodeTps: 25,
            prefillTps: 0,
            decodeTpsMax: null,
            prefillTpsMax: null,
          },
        ],
      }),
    );
    expect(s.peakDecodeTps).toBe(25);
  });
});
