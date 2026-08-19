import { describe, it, expect } from "vitest";
import {
  requireAdmin,
  requireOrgMember,
  requireRole,
} from "~/src/middlewares/rbac";
import type { SessionAuth } from "~/src/types";

function makeContext(session: SessionAuth | undefined) {
  return {
    get: (key: string) => (key === "session" ? session : undefined),
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as never;
}

const session = (over: Partial<SessionAuth>): SessionAuth => ({
  userId: "user_1",
  sessionId: "sess_1",
  organizationId: "org_1",
  role: "member",
  email: "a@b.c",
  expiresAt: 9999999999,
  ...over,
});

const callNext = async () => undefined;

describe("requireOrgMember", () => {
  it("rejects when there is no session", async () => {
    const res = (await requireOrgMember(
      makeContext(undefined),
      callNext,
    )) as Response;
    expect(res.status).toBe(401);
  });

  it("rejects when there is no active organization", async () => {
    const res = (await requireOrgMember(
      makeContext(session({ organizationId: null })),
      callNext,
    )) as Response;
    expect(res.status).toBe(403);
  });

  it("rejects viewers", async () => {
    const res = (await requireOrgMember(
      makeContext(session({ role: "viewer" })),
      callNext,
    )) as Response;
    expect(res.status).toBe(403);
  });

  it("allows members through", async () => {
    let passed = false;
    const res = await requireOrgMember(makeContext(session({})), async () => {
      passed = true;
    });
    expect(passed).toBe(true);
    expect(res).toBeUndefined();
  });
});

describe("requireRole", () => {
  it("rejects when the session role is not in the list", async () => {
    const res = (await requireRole("owner", "admin")(
      makeContext(session({ role: "viewer" })),
      callNext,
    )) as Response;
    expect(res.status).toBe(403);
  });

  it("allows roles in the list", async () => {
    let passed = false;
    await requireRole("owner", "admin")(
      makeContext(session({ role: "admin" })),
      async () => {
        passed = true;
      },
    );
    expect(passed).toBe(true);
  });

  it("rejects when there is no session", async () => {
    const res = (await requireRole("owner")(
      makeContext(undefined),
      callNext,
    )) as Response;
    expect(res.status).toBe(401);
  });
});

describe("requireAdmin", () => {
  it("allows owners and admins only", async () => {
    let passed = false;
    await requireAdmin()(makeContext(session({ role: "owner" })), async () => {
      passed = true;
    });
    expect(passed).toBe(true);

    const res = (await requireAdmin()(
      makeContext(session({ role: "member" })),
      callNext,
    )) as Response;
    expect(res.status).toBe(403);
  });
});
