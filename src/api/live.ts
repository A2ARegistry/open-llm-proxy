// [fork] W11: live box metrics for the dashboard's Live page.
import type { AppBindings } from "../app";
import { queryHistory, sampleAt } from "../live/sample-query";
import { buildLiveSnapshot } from "../live/snapshot";
import { getRequest } from "../metrics/request-log";
import { Hono } from "hono";

export const liveRouter = new Hono<AppBindings>();

// GET /api/live — one snapshot of the org's inference server and host.
liveRouter.get("/", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  return c.json({ snapshot: await buildLiveSnapshot(c.env, orgId) });
});

const MAX_HISTORY_RANGE_S = 400 * 86400;

function unixSeconds(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

// GET /api/live/history?from=&to= — stored box history (unix seconds).
liveRouter.get("/history", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const from = unixSeconds(c.req.query("from"));
  const to = unixSeconds(c.req.query("to"));
  if (from === null || to === null) {
    return c.json({ error: "from and to must be unix seconds" }, 400);
  }
  if (from >= to) return c.json({ error: "from must be before to" }, 400);
  if (to - from > MAX_HISTORY_RANGE_S) {
    return c.json({ error: "range must be at most 400 days" }, 400);
  }
  return c.json(await queryHistory(c.env, orgId, from, to));
});

// GET /api/live/at?request=<id> — box state when that request started.
liveRouter.get("/at", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const request = await getRequest(c.env, orgId, c.req.query("request") ?? "");
  if (!request) return c.json({ error: "request not found" }, 404);
  const start = request.timestamp - request.latency_ms / 1000;
  return c.json({
    sample: await sampleAt(c.env, orgId, request.provider, start),
  });
});
