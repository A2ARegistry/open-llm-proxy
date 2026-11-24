import { RANGE_PRESETS, RangePreset } from "../lib/timeRange";
import { TimeRange } from "../lib/useTimeRange";
import { Button, Select } from "./ui";
import { RefreshCw } from "lucide-react";

/** Range picker plus a refresh button that moves the window's end to now. */
export function TimeRangeControl({
  time,
  allowed,
  refreshing = false,
}: {
  time: TimeRange;
  allowed: readonly RangePreset[];
  refreshing?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Select
        className="w-40"
        value={time.range}
        onChange={(v) => time.setRange(v as RangePreset)}
        options={RANGE_PRESETS.filter((r) => allowed.includes(r.value)).map(
          (r) => ({ value: r.value, label: r.label }),
        )}
      />
      <Button
        variant="secondary"
        onClick={time.refresh}
        loading={refreshing}
        aria-label="Refresh"
        title="Refresh"
      >
        {!refreshing && <RefreshCw size={14} />}
      </Button>
    </div>
  );
}
