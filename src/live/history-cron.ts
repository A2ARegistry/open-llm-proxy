// [fork] W12: 5-min cron work for live history. Keeps the sampler alive, rolls
// up recent 10 s rows into 10-minute rows and, once a day after 03:00 UTC,
// prunes and recomputes the last 24 h of throughput rollups.
import { BOX_SAMPLER_NAME } from "../durable/box-sampler";
import { log } from "../utils/logger";
import { pruneOld, rollupRecent } from "./sample-store";
import { rollupThroughputRecent } from "./throughput-store";

const PRUNE_AFTER_UTC_HOUR = 3;
const MARKER_TTL_S = 2 * 86_400;
/** Daily throughput recompute: heals holes left by a cron outage > 2 h. */
const DAILY_THROUGHPUT_WINDOW_S = 86_400;

/** True from 03:00 UTC onwards. */
export function pruneDue(nowMs: number): boolean {
  return new Date(nowMs).getUTCHours() >= PRUNE_AFTER_UTC_HOUR;
}

async function dailyOnce(env: Env, nowMs: number): Promise<void> {
  if (!pruneDue(nowMs)) return;
  const key = `live-history:pruned:${new Date(nowMs).toISOString().slice(0, 10)}`;
  if ((await env.SESSION_CACHE.get(key)) !== null) return;
  const nowS = Math.floor(nowMs / 1000);
  await Promise.all([
    pruneOld(env, nowS),
    rollupThroughputRecent(env, nowS, DAILY_THROUGHPUT_WINDOW_S),
  ]);
  // Only after success, so a failed daily step is retried on the next tick.
  await env.SESSION_CACHE.put(key, "1", { expirationTtl: MARKER_TTL_S });
}

export async function runHistoryMaintenance(
  env: Env,
  nowMs: number,
): Promise<void> {
  const nowS = Math.floor(nowMs / 1000);
  const steps: Array<[string, () => Promise<void>]> = [
    [
      "ensureRunning",
      async () =>
        env.BOX_SAMPLER.get(
          env.BOX_SAMPLER.idFromName(BOX_SAMPLER_NAME),
        ).ensureRunning(),
    ],
    ["rollup", () => rollupRecent(env, nowS)],
    ["throughputRollup", () => rollupThroughputRecent(env, nowS)],
    ["daily", () => dailyOnce(env, nowMs)],
  ];
  const results = await Promise.allSettled(steps.map(([, run]) => run()));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      log.error(`live-history ${steps[i][0]} failed`, r.reason);
    }
  });
}
