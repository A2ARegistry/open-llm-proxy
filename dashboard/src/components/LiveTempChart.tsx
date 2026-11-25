// [fork] W12: CPU / GPU / SSD temperature and APU power on a real time axis.
import { axisTick } from "../lib/liveChart";
import type { LivePoint } from "../lib/liveSeries";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const LINE = {
  type: "linear",
  dot: false,
  isAnimationActive: false,
  connectNulls: false,
} as const;

export function LiveTempChart({
  data,
  domain,
}: {
  data: LivePoint[];
  /** [from, to] in ms. */
  domain: [number, number];
}) {
  const span = domain[1] - domain[0];
  return (
    <ResponsiveContainer width="100%" height={200}>
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
        <YAxis yAxisId="c" tick={{ fontSize: 11 }} unit="°" />
        <YAxis
          yAxisId="w"
          orientation="right"
          tick={{ fontSize: 11 }}
          unit="W"
        />
        <Tooltip labelFormatter={(t) => new Date(Number(t)).toLocaleString()} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          {...LINE}
          yAxisId="c"
          dataKey="cpuTempC"
          name="CPU °C"
          stroke="#ef4444"
        />
        <Line
          {...LINE}
          yAxisId="c"
          dataKey="gpuTempC"
          name="GPU °C"
          stroke="#f59e0b"
        />
        <Line
          {...LINE}
          yAxisId="c"
          dataKey="ssdTempC"
          name="SSD °C"
          stroke="#10b981"
        />
        <Line
          {...LINE}
          yAxisId="w"
          dataKey="gpuPowerW"
          name="APU W"
          stroke="#6366f1"
          strokeDasharray="4 2"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
