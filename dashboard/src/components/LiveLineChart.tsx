// [fork] Shared line chart of the Live page: a real time axis, a left and an
// optional right value axis, and the cursor synced with the other Live charts.
import { LIVE_SYNC, axisTick } from "../lib/liveChart";
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

export type ChartAxisSide = "left" | "right";

export interface ChartAxis {
  /** Fixed range, e.g. [0, 100] for percentages; auto when omitted. */
  domain?: [number, number];
  allowDecimals?: boolean;
  tick: (value: number) => string;
  /** Tooltip value; falls back to `tick`. */
  value?: (value: number) => string;
}

export interface ChartLine<P> {
  key: keyof P & string;
  name: string;
  color: string;
  axis?: ChartAxisSide;
  dashed?: boolean;
}

export function LiveLineChart<P extends { t: number }>({
  data,
  domain,
  lines,
  left,
  right,
  height = 200,
}: {
  data: P[];
  /** [from, to] in ms. */
  domain: [number, number];
  lines: ChartLine<P>[];
  left: ChartAxis;
  right?: ChartAxis;
  height?: number;
}) {
  const span = domain[1] - domain[0];
  const axes: Record<ChartAxisSide, ChartAxis | undefined> = { left, right };
  const sideOf = new Map<string, ChartAxisSide>(
    lines.map((l) => [l.key, l.axis ?? "left"]),
  );
  const formatValue = (value: unknown, dataKey: unknown): string => {
    const axis = axes[sideOf.get(String(dataKey)) ?? "left"] ?? left;
    const n = Number(value);
    return (axis.value ?? axis.tick)(n);
  };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart
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
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 11 }}
          domain={left.domain}
          allowDecimals={left.allowDecimals}
          tickFormatter={(v) => left.tick(Number(v))}
        />
        {right && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 11 }}
            domain={right.domain}
            allowDecimals={right.allowDecimals}
            tickFormatter={(v) => right.tick(Number(v))}
          />
        )}
        <Tooltip
          formatter={(value, _name, item) => formatValue(value, item.dataKey)}
          labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {lines.map((l) => (
          <Line
            key={l.key}
            yAxisId={l.axis ?? "left"}
            type="linear"
            dataKey={l.key}
            name={l.name}
            stroke={l.color}
            strokeDasharray={l.dashed ? "4 2" : undefined}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
