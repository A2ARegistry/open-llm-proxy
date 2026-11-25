// [fork] One throughput series in a card header: colored dot (matches the
// chart series and its axis), headline rate, and peak underneath.
import { fmtTps } from "../lib/format";

export function ThroughputStat({
  label,
  color,
  value,
  peak,
}: {
  label: string;
  /** Series color, same as the chart line and axis ticks. */
  color: string;
  /** Headline rate: current in live mode, average for a stored range. */
  value: number | null | undefined;
  peak: number | null | undefined;
}) {
  return (
    <div className="min-w-[7.5rem] text-right">
      <div className="flex items-center justify-end gap-1.5 text-xs text-gray-500">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums text-gray-900">
        {fmtTps(value)}
      </div>
      <div className="text-xs tabular-nums text-gray-500">
        peak {fmtTps(peak)}
      </div>
    </div>
  );
}
