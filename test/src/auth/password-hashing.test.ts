// [fork] scrypt password hashing (Workers caps native PBKDF2 at 100k).
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  verifyPasswordRecord,
} from "~/src/auth/password-hashing";
import { pbkdf2Sha256, toBase64 } from "~/src/utils/crypto";

async function legacyPbkdf2(password: string, iterations = 1000) {
  const salt = new Uint8Array(16).fill(7);
  const hash = await pbkdf2Sha256(password, salt, iterations);
  return `pbkdf2:${iterations}:${toBase64(salt)}:${toBase64(hash)}`;
}

describe("password hashing", () => {
  it("hashes with scrypt N=16384 r=16 p=1 and verifies", async () => {
    const hash = await hashPassword("s3cret!!word");
    expect(hash).toMatch(/^scrypt:16384:16:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("s3cret!!word", hash)).toBe(true);
    expect(await verifyPassword("other!", hash)).toBe(false);
  }, 30000);

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  }, 30000);

  it("still verifies content-auth PBKDF2 hashes", async () => {
    const hash = await legacyPbkdf2("old-password");
    expect(await verifyPassword("old-password", hash)).toBe(true);
    expect(await verifyPassword("nope", hash)).toBe(false);
  });

  it.each([
    "argon2:junk",
    "scrypt:16384:16:1:onlysalt",
    "scrypt:999999999:16:1:AAAA:AAAA",
    "pbkdf2:abc:AAAA:AAAA",
    "",
  ])("rejects malformed or unsupported hash %j", async (stored) => {
    expect(await verifyPassword("x", stored)).toBe(false);
  });

  it("verifies the better-auth { hash, password } call shape", async () => {
    const hash = await legacyPbkdf2("pw");
    expect(await verifyPasswordRecord({ hash, password: "pw" })).toBe(true);
    expect(await verifyPasswordRecord({ hash, password: "no" })).toBe(false);
  });
});
