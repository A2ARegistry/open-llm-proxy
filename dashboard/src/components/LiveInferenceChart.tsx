// [fork] KV pool, prompt cache hits and draft acceptance (%) with the queue
// length on its own axis, over time.
import { fmtPctTick } from "../lib/liveChart";
import type { LivePoint } from "../lib/liveSeries";
import { LiveLineChart, type ChartLine } from "./LiveLineChart";

const LINES: ChartLine<LivePoint>[] = [
  { key: "kvPct", name: "KV pool %", color: "#8b5cf6" },
  { key: "cacheHitPct", name: "Cache hits %", color: "#10b981" },
  { key: "draftPct", name: "Draft acceptance %", color: "#0ea5e9" },
  {
    key: "queued",
    name: "Queued",
    color: "#ef4444",
    axis: "right",
    dashed: true,
  },
];

export function LiveInferenceChart({
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
      right={{
        allowDecimals: false,
        tick: (v) => String(Math.round(v)),
        value: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      }}
    />
  );
}
