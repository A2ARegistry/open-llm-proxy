// [fork] CPU, RAM, GPU and GPU memory use (%) over time.
import { fmtPctTick } from "../lib/liveChart";
import type { LivePoint } from "../lib/liveSeries";
import { LiveLineChart, type ChartLine } from "./LiveLineChart";

const LINES: ChartLine<LivePoint>[] = [
  { key: "cpuPercent", name: "CPU %", color: "#ef4444" },
  { key: "ramPct", name: "RAM %", color: "#10b981" },
  { key: "gpuBusyPercent", name: "GPU %", color: "#f59e0b" },
  { key: "gpuMemPct", name: "GPU memory %", color: "#6366f1", dashed: true },
];

export function LiveUsageChart({
  data,
  domain,
}: {
  data: LivePoint[];
  /** [from, to] in ms. */
  domain: [number, number];
}) {
  return (
    <LiveLineChart
      data={data}
      domain={domain}
      lines={LINES}
      left={{ domain: [0, 100], tick: fmtPctTick }}
    />
  );
}
