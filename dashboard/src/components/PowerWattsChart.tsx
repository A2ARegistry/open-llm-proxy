// [fork] W13: APU watts over the Power page range, with the range average.
import { axisTick } from "../lib/liveChart";
import type { HistoryPoint } from "../lib/liveHistory";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function PowerWattsChart({
  data,
  domain,
  avgW,
}: {
  data: HistoryPoint[];
  /** [from, to] in ms. */
  domain: [number, number];
  avgW: number | null;
}) {
  const span = domain[1] - domain[0];
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart
        data={data}
        margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={domain}
          allowDataOverflow
          tick={{ fontSize: 11 }}
          tickFormatter={(t) => axisTick(Number(t), span)}
          minTickGap={40}
        />
        <YAxis tick={{ fontSize: 11 }} unit="W" />
        <Tooltip
          labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
          formatter={(v) => [`${Number(v).toFixed(1)} W`, "APU"]}
        />
        <Line
          type="linear"
          dataKey="gpuPowerW"
          name="APU"
          stroke="#6366f1"
          dot={false}
          isAnimationActive={false}
          connectNulls={false}
        />
        {avgW !== null && (
          <ReferenceLine
            y={avgW}
            stroke="#f59e0b"
            strokeDasharray="4 4"
            label={{
              value: `avg ${avgW.toFixed(1)} W`,
              fontSize: 11,
              position: "insideTopRight",
            }}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
