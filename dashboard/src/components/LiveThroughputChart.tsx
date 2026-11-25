// [fork] W12: decode / prefill throughput on a real time axis. A null point
// breaks the line (paused or unsampled periods are not drawn as data).
import { fmtTps } from "../lib/format";
import {
  LIVE_SYNC,
  axisTick,
  type ThroughputChartPoint,
} from "../lib/liveChart";
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

export const DECODE_COLOR = "#f59e0b";
export const PREFILL_COLOR = "#3b82f6";

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
        {...LIVE_SYNC}
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
        {/* Prefill runs ~10x decode, so each series gets its own scale:
            decode on the left, prefill on the right, ticks in series color. */}
        <YAxis yAxisId="decode" tick={{ fontSize: 11, fill: DECODE_COLOR }} />
        <YAxis
          yAxisId="prefill"
          orientation="right"
          tick={{ fontSize: 11, fill: PREFILL_COLOR }}
        />
        <Tooltip
          formatter={(v) => fmtTps(Number(v))}
          labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area
          yAxisId="decode"
          type="linear"
          dataKey="decodeTps"
          name="Decode"
          stroke={DECODE_COLOR}
          fill="#fde68a"
          isAnimationActive={false}
          connectNulls={false}
        />
        <Area
          yAxisId="prefill"
          type="linear"
          dataKey="prefillTps"
          name="Prefill"
          stroke={PREFILL_COLOR}
          fill="#bfdbfe"
          fillOpacity={0.4}
          isAnimationActive={false}
          connectNulls={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
