// [fork] W7: upstream (box) health for the dashboard.
import type { AppBindings } from "../app";
import { readUpstreamHealth } from "../health/upstream-health";
import { Hono } from "hono";

export const healthRouter = new Hono<AppBindings>();

// GET /api/health/upstreams — last cron health check per VPC upstream the
// caller's organization may use.
healthRouter.get("/upstreams", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  return c.json({ upstreams: await readUpstreamHealth(c.env, orgId) });
});
