// [fork] Password hashing: scrypt instead of PBKDF2 (see FORK.md).
//
// Cloudflare Workers caps native PBKDF2 at 100,000 iterations, a sixth of
// OWASP's figure, and pure-JS PBKDF2 at 600k costs ~8 s of CPU. scrypt is
// memory-hard (32 MiB per guess here) and costs ~1.2 s of CPU, paid only on
// sign-in, sign-up and password changes; API keys are unaffected.
//
// Formats:
//   scrypt:<N>:<r>:<p>:<salt b64>:<hash b64>   (written)
//   pbkdf2:<iterations>:<salt b64>:<hash b64>  (content-auth's; still verified)
import {
  fromBase64,
  pbkdf2Sha256,
  randomBytes,
  toBase64,
} from "../utils/crypto";
import { scryptAsync } from "@noble/hashes/scrypt.js";

const SCRYPT_N = 16384;
const SCRYPT_R = 16;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Upper bounds for parameters read from a stored hash (CPU/memory guard). */
const MAX_N = 65536;
const MAX_R = 16;
const MAX_P = 4;
const MAX_PBKDF2_ITERATIONS = 100000;

async function scryptHash(
  password: string,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  dkLen: number,
): Promise<Uint8Array> {
  return scryptAsync(password.normalize("NFKC"), salt, {
    N,
    r,
    p,
    dkLen,
    maxmem: 128 * N * r * p + 1024 * 1024,
  });
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function boundedInt(raw: string | undefined, max: number): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= max ? value : null;
}

/** Hash a password with scrypt in the `scrypt:N:r:p:salt:hash` format. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptHash(
    password,
    salt,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    KEY_LENGTH,
  );
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${toBase64(salt)}:${toBase64(hash)}`;
}

/**
 * Verify a password against a stored scrypt or content-auth PBKDF2 hash.
 * Malformed, unsupported or out-of-bounds hashes never verify.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split(":");
  try {
    if (parts[0] === "scrypt" && parts.length === 6) {
      const N = boundedInt(parts[1], MAX_N);
      const r = boundedInt(parts[2], MAX_R);
      const p = boundedInt(parts[3], MAX_P);
      if (N === null || r === null || p === null) return false;
      const expected = fromBase64(parts[5]);
      const actual = await scryptHash(
        password,
        fromBase64(parts[4]),
        N,
        r,
        p,
        expected.length,
      );
      return equalBytes(actual, expected);
    }
    if (parts[0] === "pbkdf2" && parts.length === 4) {
      const iterations = boundedInt(parts[1], MAX_PBKDF2_ITERATIONS);
      if (iterations === null) return false;
      const expected = fromBase64(parts[3]);
      const actual = await pbkdf2Sha256(
        password,
        fromBase64(parts[2]),
        iterations,
        expected.length,
      );
      return equalBytes(actual, expected);
    }
  } catch {
    return false;
  }
  return false;
}

/** better-auth's `password.verify` call shape. */
export function verifyPasswordRecord(data: {
  hash: string;
  password: string;
}): Promise<boolean> {
  return verifyPassword(data.password, data.hash);
}
