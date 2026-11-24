// [fork] W12: stored 10-minute request throughput per organization.
import { vpcProviders } from "./provider-binding";
import { rollupWindow } from "./rollup-window";
import {
  countRequests,
  rollupThroughput,
  spreadThroughput,
  throughputRowsStatement,
  type ThroughputRequest,
} from "./throughput";

const SAMPLE_S = 10;
const ROLLUP_S = 600;

/**
 * Recompute the completed 10-minute buckets of the last 2 h for every org
 * that uses the box. Two D1 round trips (all reads, then all writes).
 * `requests` counts the requests overlapping the bucket, so one long request
 * counts in each bucket it spans. Idle buckets are written with zeros.
 */
export async function rollupThroughputRecent(
  env: Env,
  nowS: number,
): Promise<void> {
  const { from, to } = rollupWindow(nowS);
  const byOrg = new Map<string, string[]>();
  for (const p of await vpcProviders(env)) {
    byOrg.set(p.organizationId, [
      ...(byOrg.get(p.organizationId) ?? []),
      p.provider,
    ]);
  }
  const orgs = [...byOrg.keys()];
  if (orgs.length === 0) return;

  const reads = await env.DB.batch<ThroughputRequest>(
    orgs.map((org) =>
      throughputRowsStatement(env, org, byOrg.get(org)!, from, to),
    ),
  );
  const insert = env.DB.prepare(
    `INSERT OR REPLACE INTO throughput_rollups
       (organization_id, ts, decode_tps, decode_tps_max, prefill_tps, prefill_tps_max, requests)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const writes = orgs.flatMap((org, i) => {
    const rows = reads[i].results;
    const counts = countRequests(rows, from, to, ROLLUP_S);
    return rollupThroughput(spreadThroughput(rows, from, to, SAMPLE_S)).map(
      (r, j) =>
        insert.bind(
          org,
          r.ts,
          r.decode_tps,
          r.decode_tps_max,
          r.prefill_tps,
          r.prefill_tps_max,
          counts[j],
        ),
    );
  });
  await env.DB.batch(writes);
}

/** Stored rollups of `[from, to)` (bucket starts), oldest first. */
export function throughputRollupsStatement(
  env: Env,
  orgId: string,
  from: number,
  to: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT ts, decode_tps, decode_tps_max, prefill_tps, prefill_tps_max, requests
       FROM throughput_rollups
      WHERE organization_id = ? AND ts >= ? AND ts < ?
      ORDER BY ts`,
  ).bind(orgId, from, to);
}
