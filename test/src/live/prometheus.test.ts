// [fork] W11: Prometheus text parsing for the live monitor.
import halogenMetrics from "../../fixtures/live/halogen-metrics.txt?raw";
import nodeMetrics from "../../fixtures/live/node-exporter-metrics.txt?raw";
import { describe, expect, it } from "vitest";
import { parsePrometheus, promSum, promValue } from "~/src/live/prometheus";

describe("parsePrometheus", () => {
  it("parses llama.cpp names with colons", () => {
    const s = parsePrometheus(halogenMetrics);
    expect(promValue(s, "llamacpp:tokens_predicted_total")).toBeGreaterThan(0);
    expect(promValue(s, "halogen:kv_pool_positions")).toBe(1048576);
  });

  it("parses labels with quotes and commas", () => {
    expect(parsePrometheus('x{a="1",b="p,q"} 2')).toEqual([
      { name: "x", labels: { a: "1", b: "p,q" }, value: 2 },
    ]);
  });

  it("unescapes quotes and backslashes in label values", () => {
    const [sample] = parsePrometheus('x{a="say \\"hi\\"",b="c:\\\\d"} 1');
    expect(sample.labels).toEqual({ a: 'say "hi"', b: "c:\\d" });
  });

  it("skips comments, blank lines, NaN and timestamps", () => {
    const text = "# HELP z z\n\ny NaN\nz 3 1700000000000\nbad line\n";
    expect(parsePrometheus(text)).toEqual([
      { name: "z", labels: {}, value: 3 },
    ]);
  });

  it("matches label subsets and returns null for unknown names", () => {
    const s = parsePrometheus('m{a="1",b="2"} 5\nm{a="9"} 7');
    expect(promValue(s, "m", { b: "2" })).toBe(5);
    expect(promValue(s, "m", { a: "9" })).toBe(7);
    expect(promValue(s, "m", { a: "3" })).toBeNull();
    expect(promValue(s, "nope")).toBeNull();
  });
});

describe("promSum", () => {
  it("adds matching series", () => {
    const s = parsePrometheus(nodeMetrics);
    expect(
      promSum(s, "node_cpu_seconds_total", { mode: "idle" }),
    ).toBeGreaterThan(0);
    expect(promSum(s, "node_unknown_metric")).toBeNull();
  });
});
