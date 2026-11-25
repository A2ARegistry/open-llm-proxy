// [fork] W12: decode / prefill throughput on a real time axis. A null point
// breaks the line (paused or unsampled periods are not drawn as data).
import { fmtTps } from "../lib/format";
import { axisTick, type ThroughputChartPoint } from "../lib/liveChart";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function LiveThroughputChart({
  data,
  domain,
}: {
  data: ThroughputChartPoint[];
  /** [from, to] in ms. */
  domain: [number, number];
}) {
  const span = domain[1] - domain[0];
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart
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
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip
          formatter={(v) => fmtTps(Number(v))}
          labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area
          type="linear"
          dataKey="decodeTps"
          name="Decode"
          stroke="#f59e0b"
          fill="#fde68a"
          isAnimationActive={false}
          connectNulls={false}
        />
        <Area
          type="linear"
          dataKey="prefillTps"
          name="Prefill"
          stroke="#3b82f6"
          fill="#bfdbfe"
          fillOpacity={0.4}
          isAnimationActive={false}
          connectNulls={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
