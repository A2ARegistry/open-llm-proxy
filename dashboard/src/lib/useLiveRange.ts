// [fork] W12: the Live page's range, kept in the `range` URL param ("live"
// is the default and leaves the param out).
import { isLiveRange, parseLiveRange, type LiveRange } from "./liveChart";
import { rangeWindow } from "./timeRange";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

export interface LiveRangeState {
  range: LiveRange;
  isLive: boolean;
  /** [start, end) in unix seconds of a past range; meaningless when live. */
  start: number;
  end: number;
  /** Bumps on every refresh, so callers can key queries on it. */
  refreshes: number;
  setRange(range: LiveRange): void;
  /** Move a past range's end to now. */
  refresh(): void;
}

export function useLiveRange(): LiveRangeState {
  const [params, setParams] = useSearchParams();
  const range = parseLiveRange(params.get("range"));
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const [refreshes, setRefreshes] = useState(0);
  const win = useMemo(
    () => rangeWindow(isLiveRange(range) ? "1h" : range, anchorMs),
    [range, anchorMs],
  );

  return {
    range,
    isLive: isLiveRange(range),
    ...win,
    refreshes,
    setRange: (next) => {
      const updated = new URLSearchParams(params);
      if (isLiveRange(next)) updated.delete("range");
      else updated.set("range", next);
      setAnchorMs(Date.now());
      setParams(updated, { replace: true });
    },
    refresh: () => {
      setAnchorMs(Date.now());
      setRefreshes((n) => n + 1);
    },
  };
}
