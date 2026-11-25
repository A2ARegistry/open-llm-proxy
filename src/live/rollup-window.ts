// [fork] W12: the completed 10-minute buckets a cron rollup (re)computes.
const BUCKET_S = 600;
/** Every 5-min cron tick recomputes the last 2 h. */
export const RECENT_WINDOW_S = 7200;

/**
 * Buckets `[from, to)` (unix seconds, bucket-aligned) that are complete and
 * within the last `windowS` seconds: the newest bucket must have ended at
 * least 60 s ago.
 */
export function rollupWindow(
  nowS: number,
  windowS: number = RECENT_WINDOW_S,
): { from: number; to: number } {
  return {
    from: Math.floor((nowS - windowS) / BUCKET_S) * BUCKET_S,
    to: Math.floor((nowS - 60) / BUCKET_S) * BUCKET_S,
  };
}
