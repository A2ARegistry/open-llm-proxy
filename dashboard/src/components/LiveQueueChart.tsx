// [fork] Requests waiting for a slot and how long the oldest one has waited,
// over time.
import { fmtMs } from "../lib/format";
import type { LivePoint } from "../lib/liveSeries";
import { LiveLineChart, type ChartLine } from "./LiveLineChart";

const LINES: ChartLine<LivePoint>[] = [
  { key: "queued", name: "Queued", color: "#ef4444" },
  {
    key: "longestWaitS",
    name: "Longest wait",
    color: "#f59e0b",
    axis: "right",
    dashed: true,
  },
];

/** Axis tick; one decimal below 10 s so sub-second waits don't repeat "0 s". */
function secondsTick(v: number): string {
  return v < 10 ? `${Number(v.toFixed(1))} s` : `${Math.round(v)} s`;
}

export function LiveQueueChart({
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
        allowDecimals: false,
        tick: (v) => String(Math.round(v)),
        value: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
      }}
      right={{ tick: secondsTick, value: (v) => fmtMs(v * 1000) }}
    />
  );
}
