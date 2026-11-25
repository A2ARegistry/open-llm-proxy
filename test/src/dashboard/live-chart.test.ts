// [fork] W12: pure helpers behind the Live page charts and range picker.
import type { LiveHistory } from "../../../dashboard/src/lib/api";
import {
  axisTick,
  bucketLabel,
  fmtC,
  fmtGb,
  fmtPctValue,
  hasStoredSamples,
  isLiveRange,
  liveWindow,
  parseLiveRange,
  seededLivePoints,
  throughputPoints,
  historySubtitle,
  throughputEmptyTitle,
  throughputStats,
  withGaps,
} from "../../../dashboard/src/lib/liveChart";
import type { LivePoint } from "../../../dashboard/src/lib/liveSeries";
import { describe, expect, it } from "vitest";

describe("parseLiveRange / isLiveRange", () => {
  it("defaults to live for a missing or unknown value", () => {
    expect(parseLiveRange(null)).toBe("live");
    expect(parseLiveRange("nope")).toBe("live");
    expect(parseLiveRange("live")).toBe("live");
  });

  it("accepts every preset the Live page offers", () => {
    for (const r of ["1h", "6h", "24h", "7d", "30d", "90d", "1y"])
      expect(parseLiveRange(r)).toBe(r);
  });

  it("isLiveRange tells live from history mode", () => {
    expect(isLiveRange("live")).toBe(true);
    expect(isLiveRange("1h")).toBe(false);
  });
});

describe("withGaps", () => {
  it("inserts an all-null point between points further apart than the gap", () => {
    const pts = [
      { t: 0, a: 1, b: 2 },
      { t: 2000, a: 3, b: 4 },
      { t: 60_000, a: 5, b: 6 },
    ];
    const out = withGaps(pts, 5000);
    expect(out).toHaveLength(4);
    expect(out[2]).toEqual({ t: 31_000, a: null, b: null });
    expect(out[3]).toBe(pts[2]);
  });

  it("leaves a gap of exactly the limit alone", () => {
    const pts = [
      { t: 0, a: 1 },
      { t: 5000, a: 2 },
    ];
    expect(withGaps(pts, 5000)).toEqual(pts);
  });

  it("handles empty and single-point input", () => {
    expect(withGaps([], 5000)).toEqual([]);
    expect(withGaps([{ t: 1, a: 1 }], 5000)).toEqual([{ t: 1, a: 1 }]);
  });
});

describe("bucketLabel", () => {
  it("labels seconds, minutes and hours", () => {
    expect(bucketLabel(10)).toBe("10 s");
    expect(bucketLabel(600)).toBe("10 min");
    expect(bucketLabel(7200)).toBe("2 h");
    expect(bucketLabel(43_800)).toBe("12.2 h");
  });
});

describe("axisTick", () => {
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const t = new Date(2026, 10, 24, 14, 3, 5).getTime();

  it("shows seconds on a short window", () => {
    expect(axisTick(t, 10 * MIN)).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("shows hours and minutes up to a day", () => {
    const s = axisTick(t, 6 * 60 * MIN);
    expect(s).toMatch(/\d{1,2}:\d{2}/);
    expect(s).not.toMatch(/:\d{2}:\d{2}/);
  });

  it("adds the date beyond 24 h and drops the time beyond two weeks", () => {
    const week = axisTick(t, 7 * DAY);
    expect(week).toMatch(/24/);
    expect(week).toMatch(/\d{1,2}:\d{2}/);
    const year = axisTick(t, 365 * DAY);
    expect(year).toMatch(/24/);
    expect(year).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("liveWindow", () => {
  it("covers the browser history ending at the latest sample", () => {
    expect(liveWindow(1_000_000)).toEqual([400_000, 1_000_000]);
  });
});

describe("throughputPoints / throughputStats", () => {
  const tp = [
    { ts: 100, decodeTps: 0, prefillTps: 0 },
    { ts: 110, decodeTps: 55, prefillTps: 200 },
    { ts: 120, decodeTps: 30, prefillTps: 800 },
  ];

  it("converts unix seconds to ms", () => {
    expect(throughputPoints(tp).map((p) => p.t)).toEqual([
      100_000, 110_000, 120_000,
    ]);
    expect(throughputPoints(tp)[1]).toEqual({
      t: 110_000,
      decodeTps: 55,
      prefillTps: 200,
    });
  });

  it("averages the complete buckets (not the in-progress one) and reports peaks", () => {
    expect(throughputStats(tp)).toEqual({
      decodeNow: 27.5,
      prefillNow: 100,
      decodePeak: 55,
      prefillPeak: 800,
    });
  });

  it("averages only the last minute of complete buckets", () => {
    const pts = [100, 0, 6, 0, 0, 0, 0, 0, 999].map((d, i) => ({
      ts: i * 10,
      decodeTps: d,
      prefillTps: d * 2,
    }));
    // Complete buckets 2..7 (6 of them); bucket 0 is older, bucket 8 is filling.
    expect(throughputStats(pts)).toMatchObject({
      decodeNow: 1,
      prefillNow: 2,
      decodePeak: 999,
    });
  });

  it("is null with no points", () => {
    expect(throughputStats([])).toEqual({
      decodeNow: null,
      prefillNow: null,
      decodePeak: null,
      prefillPeak: null,
    });
  });

  it("uses the only point when there is just one", () => {
    expect(throughputStats([tp[2]])).toMatchObject({
      decodeNow: 30,
      prefillNow: 800,
    });
  });

  it("is null without data", () => {
    expect(throughputStats([])).toEqual({
      decodeNow: null,
      prefillNow: null,
      decodePeak: null,
      prefillPeak: null,
    });
  });
});

describe("throughputEmptyTitle", () => {
  it("is null when the snapshot has a throughput series", () => {
    expect(throughputEmptyTitle([{ ts: 0, decodeTps: 0, prefillTps: 0 }])).toBe(
      null,
    );
  });

  it("says there are no self-hosted providers for an empty series", () => {
    expect(throughputEmptyTitle([])).toBe("No self-hosted providers");
  });
});

describe("historySubtitle", () => {
  it("names the resolution of raw rows", () => {
    expect(historySubtitle(10)).toBe("Stored samples, 10 s resolution");
  });

  it("warns that rollups lag for 10-minute buckets and coarser", () => {
    expect(historySubtitle(600)).toBe(
      "Stored samples, 10 min resolution · latest ~15 min not yet rolled up",
    );
    expect(historySubtitle(3600)).toContain("not yet rolled up");
  });
});

describe("hasStoredSamples", () => {
  const empty: LiveHistory = {
    from: 0,
    to: 600,
    bucketS: 10,
    inference: null,
    host: null,
    throughput: [],
  };

  it("is false for an empty response", () => {
    expect(hasStoredSamples(empty)).toBe(false);
    expect(
      hasStoredSamples({
        ...empty,
        host: { binding: "BOXSTATS", points: [] },
        inference: { binding: "HALOGEN", points: [] },
      }),
    ).toBe(false);
  });

  it("is true with throughput, host or inference points", () => {
    const point = { ts: 0, avg: {}, max: {}, samples: 1 };
    expect(
      hasStoredSamples({
        ...empty,
        throughput: [
          {
            ts: 0,
            decodeTps: 0,
            prefillTps: 0,
            decodeTpsMax: null,
            prefillTpsMax: null,
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasStoredSamples({
        ...empty,
        host: { binding: "BOXSTATS", points: [point as never] },
      }),
    ).toBe(true);
    expect(
      hasStoredSamples({
        ...empty,
        inference: { binding: "HALOGEN", points: [point as never] },
      }),
    ).toBe(true);
  });
});

describe("value formatters", () => {
  it("formats gigabytes, celsius and percentages, dashes for null", () => {
    expect(fmtGb(2 * 1024 ** 3)).toBe("2.0 GB");
    expect(fmtGb(null)).toBe("—");
    expect(fmtC(70.4)).toBe("70 °C");
    expect(fmtC(null)).toBe("—");
    expect(fmtPctValue(42.4)).toBe("42%");
    expect(fmtPctValue(null)).toBe("Unavailable");
  });
});

describe("seededLivePoints", () => {
  const pt = (t: number, c: number | null = 40): LivePoint => ({
    t,
    cpuPercent: c,
    gpuBusyPercent: c,
    cpuTempC: c,
    gpuTempC: c,
    ssdTempC: c,
    gpuPowerW: c,
  });
  const isBreak = (p: LivePoint) => p.cpuTempC === null;

  it("returns the polled points (with gaps) when there is no seed", () => {
    const live = [pt(100_000), pt(102_000)];
    expect(seededLivePoints([], live, 0)).toEqual(live);
  });

  it("returns the seed alone before the first poll", () => {
    const seed = [pt(10_000), pt(20_000)];
    expect(seededLivePoints(seed, [], 0)).toEqual(seed);
  });

  it("keeps 10 s seed points joined (no break between them)", () => {
    const seed = [pt(10_000), pt(20_000), pt(30_000)];
    const out = seededLivePoints(seed, [pt(32_000)], 0);
    expect(out.map((p) => p.t)).toEqual([10_000, 20_000, 30_000, 32_000]);
    expect(out.some(isBreak)).toBe(false);
  });

  it("drops seed points at or after the first poll and before the window", () => {
    const seed = [pt(5_000), pt(10_000), pt(20_000), pt(30_000)];
    const out = seededLivePoints(seed, [pt(20_000), pt(22_000)], 8_000);
    expect(out.map((p) => p.t)).toEqual([10_000, 20_000, 22_000]);
  });

  it("breaks the line where stored samples end well before the first poll", () => {
    const seed = [pt(10_000), pt(20_000)];
    const out = seededLivePoints(seed, [pt(80_000)], 0);
    expect(out).toHaveLength(4);
    expect(isBreak(out[2])).toBe(true);
    expect(out[2].t).toBeGreaterThan(20_000);
    expect(out[2].t).toBeLessThan(80_000);
  });

  it("still marks gaps between polled points", () => {
    const out = seededLivePoints([], [pt(100_000), pt(120_000)], 0);
    expect(out).toHaveLength(3);
    expect(isBreak(out[1])).toBe(true);
  });
});
