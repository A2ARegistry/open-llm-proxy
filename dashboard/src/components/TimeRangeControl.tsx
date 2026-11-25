import { RANGE_PRESETS, RangePreset } from "../lib/timeRange";
import { Button, Select } from "./ui";
import { RefreshCw } from "lucide-react";

/** What the control needs from a range hook (useTimeRange, useLiveRange). */
export interface RangeControlState {
  range: string;
  setRange(range: RangePreset): void;
  refresh(): void;
}

/** Range picker plus a refresh button that moves the window's end to now. */
export function TimeRangeControl({
  time,
  allowed,
  refreshing = false,
  leading,
}: {
  time: RangeControlState;
  allowed: readonly RangePreset[];
  refreshing?: boolean;
  /** Extra option shown before the presets, e.g. the Live page's "Live". */
  leading?: { value: string; label: string };
}) {
  return (
    <div className="flex items-center gap-2">
      <Select
        className="w-40"
        value={time.range}
        onChange={(v) => time.setRange(v as RangePreset)}
        options={[
          ...(leading ? [leading] : []),
          ...RANGE_PRESETS.filter((r) => allowed.includes(r.value)).map(
            (r) => ({
              value: r.value,
              label: r.label,
            }),
          ),
        ]}
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
