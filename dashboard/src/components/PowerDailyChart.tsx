// [fork] W13: electricity vs cloud-equivalent cost per day.
import { fmtUsdPrecise } from "../lib/format";
import type { PeriodTotals } from "../lib/powerTypes";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function PowerDailyChart({
  days,
  showCloud,
}: {
  days: PeriodTotals[];
  showCloud: boolean;
}) {
  const data = days.map((d) => ({
    day: new Date(d.start * 1000).toLocaleDateString([], {
      month: "short",
      day: "numeric",
    }),
    electricity: d.electricityUsd,
    cloud: d.cloudUsd,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} minTickGap={20} />
        <YAxis
          tick={{ fontSize: 11 }}
          tickFormatter={(v) => fmtUsdPrecise(Number(v))}
        />
        <Tooltip formatter={(v) => fmtUsdPrecise(Number(v))} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar
          dataKey="electricity"
          name="Electricity"
          fill="#f59e0b"
          isAnimationActive={false}
        />
        {showCloud && (
          <Bar
            dataKey="cloud"
            name="Cloud equivalent"
            fill="#6366f1"
            isAnimationActive={false}
          />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
