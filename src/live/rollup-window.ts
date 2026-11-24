// [fork] W12: the completed 10-minute buckets a cron rollup (re)computes.
const BUCKET_S = 600;

/**
 * Buckets `[from, to)` (unix seconds, bucket-aligned) that are complete and
 * within the last 2 h: the newest bucket must have ended at least 60 s ago.
 */
export function rollupWindow(nowS: number): { from: number; to: number } {
  return {
    from: Math.floor((nowS - 7200) / BUCKET_S) * BUCKET_S,
    to: Math.floor((nowS - 60) / BUCKET_S) * BUCKET_S,
  };
}
