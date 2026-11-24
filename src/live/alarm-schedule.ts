// [fork] W12: when the box sampler's next alarm fires.
import { SAMPLE_INTERVAL_S } from "./sample-row";

const STEP_MS = SAMPLE_INTERVAL_S * 1000;

/** Next 10 s boundary strictly after `nowMs`. */
export function nextBoundary(nowMs: number): number {
  return (Math.floor(nowMs / STEP_MS) + 1) * STEP_MS;
}

/**
 * Keep the cadence (`scheduled` + 10 s); when that is already in the past (the
 * alarm ran late), skip ahead to the next boundary instead of firing a burst.
 */
export function nextAlarmAt(scheduledMs: number, nowMs: number): number {
  const next = scheduledMs + STEP_MS;
  return next > nowMs ? next : nextBoundary(nowMs);
}
