// [fork] W11: live box metrics for the dashboard's Live page.
import type { AppBindings } from "../app";
import { buildLiveSnapshot } from "../live/snapshot";
import { Hono } from "hono";

export const liveRouter = new Hono<AppBindings>();

// GET /api/live — one snapshot of the org's inference server and host.
liveRouter.get("/", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  return c.json({ snapshot: await buildLiveSnapshot(c.env, orgId) });
});
