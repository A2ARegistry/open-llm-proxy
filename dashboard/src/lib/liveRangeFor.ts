// [fork] W12: which Live page range contains a given request.
import { RANGE_PRESETS, type RangePreset } from "./timeRange";

/** Smallest preset whose window, ending now, contains `tsSeconds`; caps at 1y. */
export function smallestLivePreset(
  tsSeconds: number,
  nowMs: number,
): RangePreset {
  const age = nowMs / 1000 - tsSeconds;
  const fit = RANGE_PRESETS.find((p) => p.seconds >= age);
  return (fit ?? RANGE_PRESETS[RANGE_PRESETS.length - 1]).value;
}
