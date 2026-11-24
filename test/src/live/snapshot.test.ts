// [fork] W11: mapping box metrics into a live snapshot.
import halogenHealth from "../../fixtures/live/halogen-health.json?raw";
import halogenMetrics from "../../fixtures/live/halogen-metrics.txt?raw";
import nodeMetrics from "../../fixtures/live/node-exporter-metrics.txt?raw";
import { describe, expect, it } from "vitest";
import { parsePrometheus, promValue } from "~/src/live/prometheus";
import { toHost, toInference } from "~/src/live/snapshot";

const health = JSON.parse(halogenHealth) as {
  slots: number;
  in_flight: number;
  queued: number;
  version: { api: string };
};

describe("toInference", () => {
  it("maps health and metrics", () => {
    const s = toInference("HALOGEN", halogenHealth, halogenMetrics)!;
    expect(s.binding).toBe("HALOGEN");
    expect(s.slots).toBe(health.slots);
    expect(s.inFlight).toBe(health.in_flight);
    expect(s.queued).toBe(health.queued);
    expect(s.version).toBe(health.version.api);
    expect(s.kvPoolPositions).toBe(1048576);
    expect(s.predictedTokensTotal).toBe(
      promValue(
        parsePrometheus(halogenMetrics),
        "llamacpp:tokens_predicted_total",
      ),
    );
    expect(s.kvUsageRatio).toBeGreaterThanOrEqual(0);
    expect(s.cacheHitsTotal).not.toBeNull();
    expect(s.draftAcceptedTotal).not.toBeNull();
  });

  it("keeps working with only one source", () => {
    const metricsOnly = toInference("HALOGEN", null, halogenMetrics)!;
    expect(metricsOnly.predictedTokensTotal).not.toBeNull();
    expect(metricsOnly.slots).toBeNull();
    expect(metricsOnly.version).toBeNull();
    const healthOnly = toInference("HALOGEN", halogenHealth, null)!;
    expect(healthOnly.slots).toBe(health.slots);
    expect(healthOnly.predictedTokensTotal).toBeNull();
    expect(toInference("HALOGEN", null, null)).toBeNull();
  });

  it("returns nulls for an empty metrics body and bad health JSON", () => {
    const s = toInference("HALOGEN", "not json", "")!;
    expect(s.predictedTokensTotal).toBeNull();
    expect(s.kvUsageRatio).toBeNull();
    expect(s.slots).toBeNull();
    expect(toInference("HALOGEN", "null", "")!.slots).toBeNull();
  });

  it("accepts a plain string version", () => {
    expect(toInference("HALOGEN", '{"version":"1.2.3"}', "")!.version).toBe(
      "1.2.3",
    );
    expect(toInference("HALOGEN", '{"version":{}}', "")!.version).toBeNull();
  });
});

describe("toHost", () => {
  it("maps CPU, RAM, GTT, temps and power", () => {
    const h = toHost("BOXSTATS", nodeMetrics)!;
    expect(h.binding).toBe("BOXSTATS");
    expect(h.cpuIdleSecondsTotal).toBeGreaterThan(0);
    expect(h.cpuSecondsTotal!).toBeGreaterThan(h.cpuIdleSecondsTotal!);
    expect(h.memAvailableBytes!).toBeLessThan(h.memTotalBytes!);
    expect(h.gpuBusyPercent).toBeGreaterThanOrEqual(0);
    expect(h.gpuBusyPercent).toBeLessThanOrEqual(100);
    expect(h.gpuMemUsedBytes!).toBeLessThanOrEqual(h.gpuMemTotalBytes!);
    for (const t of [h.cpuTempC, h.gpuTempC, h.ssdTempC]) {
      expect(t).toBeGreaterThan(10);
      expect(t).toBeLessThan(110);
    }
    expect(h.gpuPowerW).toBeGreaterThan(0);
  });

  it("reads each temperature from its own chip", () => {
    const text = [
      'node_hwmon_chip_names{chip="pci_cpu",chip_name="k10temp"} 1',
      'node_hwmon_chip_names{chip="pci_gpu",chip_name="amdgpu"} 1',
      'node_hwmon_chip_names{chip="nvme_nvme0",chip_name="nvme"} 1',
      'node_hwmon_temp_celsius{chip="pci_cpu",sensor="temp1"} 61',
      'node_hwmon_temp_celsius{chip="pci_gpu",sensor="temp1"} 72',
      'node_hwmon_temp_celsius{chip="nvme_nvme0",sensor="temp2"} 99',
      'node_hwmon_temp_celsius{chip="nvme_nvme0",sensor="temp1"} 43',
      'node_hwmon_power_average_watt{chip="pci_gpu",sensor="power1"} 118',
      'node_hwmon_power_average_watt{chip="pci_cpu",sensor="power1"} 5',
    ].join("\n");
    const h = toHost("BOXSTATS", text)!;
    expect(h.cpuTempC).toBe(61);
    expect(h.gpuTempC).toBe(72);
    expect(h.ssdTempC).toBe(43);
    expect(h.gpuPowerW).toBe(118);
  });

  it("never reads VRAM", () => {
    const before = toHost("BOXSTATS", nodeMetrics)!.gpuMemUsedBytes;
    const edited = nodeMetrics.replace(
      /^(node_drm_memory_vram_used_bytes\{[^}]*\}) \S+$/m,
      "$1 1",
    );
    expect(toHost("BOXSTATS", edited)!.gpuMemUsedBytes).toBe(before);
  });

  it("returns nulls for an empty body and null for a missing source", () => {
    const h = toHost("BOXSTATS", "")!;
    expect(h.cpuTempC).toBeNull();
    expect(h.gpuMemUsedBytes).toBeNull();
    expect(h.cpuSecondsTotal).toBeNull();
    expect(toHost("BOXSTATS", null)).toBeNull();
  });
});
