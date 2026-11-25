// [fork] W12: converting live snapshots into stored sample rows.
import { describe, expect, it } from "vitest";
import {
  HOST_COLUMNS,
  INFERENCE_COLUMNS,
  toHostRow,
  toInferenceRow,
} from "~/src/live/sample-row";
import type { HostSnapshot, InferenceSnapshot } from "~/src/live/snapshot";

function inf(over: Partial<InferenceSnapshot> = {}): InferenceSnapshot {
  return {
    binding: "HALOGEN",
    sampledAt: 0,
    version: "1.2.3",
    slots: 4,
    inFlight: 2,
    queued: 1,
    longestWaitS: 0.5,
    kvUsageRatio: 0.4,
    kvPoolPositions: 1000,
    kvReservedTokens: 300,
    predictedTokensTotal: 0,
    promptTokensTotal: 0,
    cacheHitsTotal: 10,
    cacheMissesTotal: 5,
    cacheTokensSavedTotal: 0,
    draftTokensTotal: 100,
    draftAcceptedTotal: 50,
    ...over,
  };
}

function host(over: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    binding: "BOX",
    sampledAt: 0,
    cpuIdleSecondsTotal: 100,
    cpuSecondsTotal: 200,
    memTotalBytes: 1000,
    memAvailableBytes: 400,
    memMappedBytes: 300,
    gpuBusyPercent: 30,
    gpuMemUsedBytes: 10,
    gpuMemTotalBytes: 100,
    cpuTempC: 50,
    gpuTempC: 60,
    ssdTempC: 40,
    gpuPowerW: 80,
    ...over,
  };
}

describe("toInferenceRow", () => {
  it("cache and draft ratios use interval deltas", () => {
    const next = inf({
      sampledAt: 10_000,
      cacheHitsTotal: 13,
      cacheMissesTotal: 6,
      cacheTokensSavedTotal: 500,
      draftTokensTotal: 200,
      draftAcceptedTotal: 130,
    });
    const row = toInferenceRow("HALOGEN", 10, inf(), next);
    expect(row.cache_hit_ratio).toBe(0.75);
    expect(row.draft_accept_ratio).toBe(0.8);
    expect(row.cache_saved_tps).toBe(50);
    expect(row).toMatchObject({
      binding: "HALOGEN",
      ts: 10,
      ok: 1,
      slots: 4,
      version: "1.2.3",
      in_flight: 2,
      queued: 1,
      longest_wait_s: 0.5,
      kv_usage_ratio: 0.4,
      kv_reserved_tokens: 300,
    });
  });

  it("counter reset gives null rate", () => {
    const next = inf({ sampledAt: 10_000, cacheHitsTotal: 2, inFlight: 7 });
    const row = toInferenceRow("HALOGEN", 10, inf(), next);
    expect(row.cache_hit_ratio).toBeNull();
    expect(row.in_flight).toBe(7);
    expect(row.kv_usage_ratio).toBe(0.4);
  });

  it("no change in counters gives null ratio, not NaN", () => {
    const row = toInferenceRow(
      "HALOGEN",
      10,
      inf(),
      inf({ sampledAt: 10_000 }),
    );
    expect(row.cache_hit_ratio).toBeNull();
    expect(row.draft_accept_ratio).toBeNull();
    expect(row.cache_saved_tps).toBe(0);
  });

  it("no prev gives null rates", () => {
    const row = toInferenceRow("HALOGEN", 10, null, inf({ sampledAt: 10_000 }));
    expect(row.ok).toBe(1);
    expect(row.cache_hit_ratio).toBeNull();
    expect(row.draft_accept_ratio).toBeNull();
    expect(row.cache_saved_tps).toBeNull();
    expect(row.in_flight).toBe(2);
  });

  it("missing source writes ok=0 row", () => {
    const row = toInferenceRow("HALOGEN", 10, inf(), null);
    expect(row.ok).toBe(0);
    expect(row.binding).toBe("HALOGEN");
    expect(row.ts).toBe(10);
    for (const col of INFERENCE_COLUMNS) {
      if (col === "binding" || col === "ts" || col === "ok") continue;
      expect(row[col]).toBeNull();
    }
  });

  it("gap longer than 25 s gives null rates", () => {
    const next = inf({
      sampledAt: 30_000,
      cacheHitsTotal: 13,
      cacheTokensSavedTotal: 500,
    });
    const row = toInferenceRow("HALOGEN", 30, inf(), next);
    expect(row.cache_hit_ratio).toBeNull();
    expect(row.cache_saved_tps).toBeNull();
    expect(row.draft_accept_ratio).toBeNull();
  });
});

describe("toHostRow", () => {
  it("host cpu busy from idle delta", () => {
    const next = host({
      sampledAt: 10_000,
      cpuIdleSecondsTotal: 108,
      cpuSecondsTotal: 220,
    });
    const row = toHostRow("BOX", 10, host(), next);
    expect(row.cpu_busy_pct).toBe(60);
    expect(row.mem_used_bytes).toBe(600);
    expect(row.mem_total_bytes).toBe(1000);
    expect(row.mem_in_use_bytes).toBe(900);
    expect(row).toMatchObject({
      binding: "BOX",
      ts: 10,
      ok: 1,
      gpu_busy_pct: 30,
      gpu_mem_used_bytes: 10,
      gpu_mem_total_bytes: 100,
      cpu_temp_c: 50,
      gpu_temp_c: 60,
      ssd_temp_c: 40,
      gpu_power_w: 80,
    });
  });

  it("missing memory figures give null used bytes", () => {
    const row = toHostRow("BOX", 10, null, host({ memAvailableBytes: null }));
    expect(row.mem_used_bytes).toBeNull();
    expect(row.mem_in_use_bytes).toBeNull();
    expect(row.cpu_busy_pct).toBeNull();
  });

  it("missing mapped bytes give null in-use bytes", () => {
    const row = toHostRow("BOX", 10, null, host({ memMappedBytes: null }));
    expect(row.mem_used_bytes).toBe(600);
    expect(row.mem_in_use_bytes).toBeNull();
  });

  it("mapped bytes count only up to what is available", () => {
    const row = toHostRow("BOX", 10, null, host({ memMappedBytes: 500 }));
    expect(row.mem_in_use_bytes).toBe(1000);
  });

  it("gap longer than 25 s gives null cpu", () => {
    const next = host({
      sampledAt: 30_000,
      cpuIdleSecondsTotal: 108,
      cpuSecondsTotal: 220,
    });
    expect(toHostRow("BOX", 30, host(), next).cpu_busy_pct).toBeNull();
  });

  it("missing source writes ok=0 row", () => {
    const row = toHostRow("BOX", 10, host(), null);
    expect(row.ok).toBe(0);
    for (const col of HOST_COLUMNS) {
      if (col === "binding" || col === "ts" || col === "ok") continue;
      expect(row[col]).toBeNull();
    }
  });
});
