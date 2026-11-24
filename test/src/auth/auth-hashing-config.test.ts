// [fork] content-auth must use the fork's scrypt hasher, not its 100k PBKDF2.
import { createAuth } from "@contentgrowth/content-auth/backend";
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  hashPassword,
  verifyPasswordRecord,
} from "~/src/auth/password-hashing";
import { getAuthFor } from "~/src/auth/setup";

vi.mock("@contentgrowth/content-auth/backend", () => ({
  createAuth: vi.fn(() => ({})),
}));
vi.mock("~/src/bootstrap/secrets", () => ({
  getAuthSecret: vi.fn(async () => "test-secret"),
}));

describe("auth password hashing config", () => {
  it("passes the scrypt hasher to content-auth", async () => {
    await getAuthFor({ ...env, BASE_URL: "https://hash.test" } as Env);
    const options = vi.mocked(createAuth).mock.calls[0][0] as unknown as {
      useCloudflareNativeHashing?: boolean;
      emailAndPassword: { password?: { hash: unknown; verify: unknown } };
    };
    expect(options.useCloudflareNativeHashing).toBe(false);
    expect(options.emailAndPassword.password).toEqual({
      hash: hashPassword,
      verify: verifyPasswordRecord,
    });
  });
});
