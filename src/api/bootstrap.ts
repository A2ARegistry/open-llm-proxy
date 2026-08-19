import { bootstrapStatus } from "../bootstrap";
import { rotateInitialAdminPassword } from "../bootstrap/admin";
import { sessionAuthMiddleware } from "../middlewares/auth-required";
import { Hono } from "hono";

/**
 * Bootstrap control plane:
 * - `GET /api/bootstrap/status` — public; drives the dashboard login hint and
 *   the forced change-password gate.
 * - `POST /api/bootstrap/change-password` — session-authenticated; rotates the
 *   seeded admin password and clears the must-change flag.
 */
export const bootstrapRouter = new Hono()
  .get("/status", async (c) => {
    return c.json(await bootstrapStatus(c.env));
  })
  .post("/change-password", sessionAuthMiddleware, async (c) => {
    const session = c.get("session");
    const body = await c.req.json().catch(() => ({}));
    const currentPassword =
      typeof (body as { currentPassword?: unknown }).currentPassword ===
      "string"
        ? (body as { currentPassword: string }).currentPassword
        : "";
    const newPassword =
      typeof (body as { newPassword?: unknown }).newPassword === "string"
        ? (body as { newPassword: string }).newPassword
        : "";
    if (newPassword.length < 12) {
      return c.json(
        { error: "New password must be at least 12 characters" },
        400,
      );
    }

    try {
      await rotateInitialAdminPassword(
        c.env,
        session.userId,
        session.organizationId,
        currentPassword,
        newPassword,
      );
    } catch (err) {
      const message =
        typeof (err as { message?: unknown }).message === "string"
          ? (err as { message: string }).message
          : "Password change failed";
      const status = message === "Current password is incorrect" ? 401 : 400;
      return c.json({ error: message }, status);
    }

    return c.json({ success: true });
  });
