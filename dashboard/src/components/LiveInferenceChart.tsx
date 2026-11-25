// [fork] KV pool, prompt cache hits and draft acceptance (%), over time.
import { fmtPctTick } from "../lib/liveChart";
import type { LivePoint } from "../lib/liveSeries";
import { LiveLineChart, type ChartLine } from "./LiveLineChart";

const LINES: ChartLine<LivePoint>[] = [
  { key: "kvPct", name: "KV pool %", color: "#8b5cf6" },
  { key: "cacheHitPct", name: "Cache hits %", color: "#10b981" },
  { key: "draftPct", name: "Draft acceptance %", color: "#0ea5e9" },
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
    />
  );
}
