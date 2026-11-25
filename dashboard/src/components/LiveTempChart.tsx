// [fork] W12: CPU / GPU / SSD temperature and APU power on a real time axis.
import type { LivePoint } from "../lib/liveSeries";
import { LiveLineChart, type ChartLine } from "./LiveLineChart";

const LINES: ChartLine<LivePoint>[] = [
  { key: "cpuTempC", name: "CPU °C", color: "#ef4444" },
  { key: "gpuTempC", name: "GPU °C", color: "#f59e0b" },
  { key: "ssdTempC", name: "SSD °C", color: "#10b981" },
  {
    key: "gpuPowerW",
    name: "APU W",
    color: "#6366f1",
    axis: "right",
    dashed: true,
  },
];

export function LiveTempChart({
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
      left={{
        tick: (v) => `${Math.round(v)}°`,
        value: (v) => `${v.toFixed(1)} °C`,
      }}
      right={{
        tick: (v) => `${Math.round(v)}W`,
        value: (v) => `${v.toFixed(0)} W`,
      }}
    />
  );
}
