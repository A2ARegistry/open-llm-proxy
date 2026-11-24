import {
  parseRange,
  rangeOption,
  RangeOption,
  RangePreset,
  rangeWindow,
} from "./timeRange";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

export interface TimeRange {
  range: RangePreset;
  option: RangeOption;
  /** [start, end) in unix seconds, fixed until `refresh` or a range change. */
  start: number;
  end: number;
  setRange: (range: RangePreset) => void;
  /** Move the window's end to now. */
  refresh: () => void;
}

/**
 * Time range held in the `range` URL param (left out when it equals
 * `fallback`). The window is computed when the range is picked or refreshed,
 * not at module load, so a long-open tab never shows a stale window.
 */
export function useTimeRange(
  allowed: readonly RangePreset[],
  fallback: RangePreset,
): TimeRange {
  const [params, setParams] = useSearchParams();
  const range = parseRange(params.get("range"), allowed, fallback);
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const win = useMemo(() => rangeWindow(range, anchorMs), [range, anchorMs]);

  return {
    range,
    option: rangeOption(range),
    ...win,
    setRange: (next) => {
      const updated = new URLSearchParams(params);
      if (next === fallback) updated.delete("range");
      else updated.set("range", next);
      setAnchorMs(Date.now());
      setParams(updated, { replace: true });
    },
    refresh: () => setAnchorMs(Date.now()),
  };
}
