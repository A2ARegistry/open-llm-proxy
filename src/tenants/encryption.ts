import {
  aes256GcmDecrypt,
  aes256GcmEncrypt,
  fromBase64,
  newId,
  nowSeconds,
  randomBytes,
  toBase64,
} from "../utils/crypto";

/**
 * Envelope encryption for provider/oauth credentials (design §Security).
 *
 * - KEK: master key derived from the `ENCRYPTION_KEY` secret — never persisted in D1.
 * - Per-tenant DEK: random 32-byte key, wrapped (encrypted) with the KEK, stored in
 *   `tenant_keys.wrapped_dek`. Unwrapped only in-memory per request.
 * - Credentials are then AES-256-GCM encrypted with the DEK.
 */

export interface EncryptedCredential {
  encrypted: string; // base64 ciphertext
  iv: string; // base64 IV
  algorithm: "AES-256-GCM";
}

export interface EnvelopeEncryptedCredential extends EncryptedCredential {
  wrappedDek: string; // base64 DEK encrypted with the KEK
  kekVersion: number;
}

export interface TenantKeys {
  organizationId: string;
  wrappedDek: string;
  wrappedDekIv: string;
  kekVersion: number;
}

const DEK_LENGTH = 32;
const KEK_LENGTH = 32;

export function encodeKey(key: Uint8Array): string {
  return toBase64(key);
}

export function decodeKey(b64: string): Uint8Array {
  return fromBase64(b64);
}

/** Derive the KEK from the ENCRYPTION_KEY secret (expects 32 raw bytes, base64-encoded or plain). */
export function deriveKek(secret: string | undefined): Uint8Array {
  if (!secret) throw new Error("ENCRYPTION_KEY secret is not configured");
  // Support both raw base64 of 32 bytes and plain ASCII secrets.
  try {
    const decoded = fromBase64(secret);
    if (decoded.length === KEK_LENGTH) return decoded;
  } catch {
    // not valid base64, fall through
  }
  const encoded = new TextEncoder().encode(secret);
  if (encoded.length >= KEK_LENGTH) return encoded.slice(0, KEK_LENGTH);
  throw new Error("ENCRYPTION_KEY must be at least 32 bytes");
}

export async function wrapDek(
  kek: Uint8Array,
  dek: Uint8Array,
  additionalData?: Uint8Array,
): Promise<{ wrappedDek: string; iv: string }> {
  const { ciphertext, iv } = await aes256GcmEncrypt(kek, dek, additionalData);
  return { wrappedDek: toBase64(ciphertext), iv: toBase64(iv) };
}

export async function unwrapDek(
  kek: Uint8Array,
  wrappedDek: string,
  wrappedDekIv: string,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  return aes256GcmDecrypt(
    kek,
    fromBase64(wrappedDekIv),
    fromBase64(wrappedDek),
    additionalData,
  );
}

export async function encryptCredential(
  dek: Uint8Array,
  plaintext: string,
  additionalData?: Uint8Array,
): Promise<EncryptedCredential> {
  const { ciphertext, iv } = await aes256GcmEncrypt(
    dek,
    plaintext,
    additionalData,
  );
  return {
    encrypted: toBase64(ciphertext),
    iv: toBase64(iv),
    algorithm: "AES-256-GCM",
  };
}

export async function decryptCredential(
  dek: Uint8Array,
  credential: EncryptedCredential,
  additionalData?: Uint8Array,
): Promise<string> {
  const plaintext = await aes256GcmDecrypt(
    dek,
    fromBase64(credential.iv),
    fromBase64(credential.encrypted),
    additionalData,
  );
  return new TextDecoder().decode(plaintext);
}

export function createDek(): Uint8Array {
  return randomBytes(DEK_LENGTH);
}

export function createEncryptionAad(organizationId: string): Uint8Array {
  return new TextEncoder().encode(`org:${organizationId}`);
}

export interface TenantKeyStore {
  get(organizationId: string): Promise<TenantKeys | undefined>;
  put(keys: TenantKeys): Promise<void>;
}

/**
 * Resolve a tenant's DEK, creating + persisting a fresh wrapped DEK on first use.
 */
export async function resolveTenantDek(
  kek: Uint8Array,
  store: TenantKeyStore,
  organizationId: string,
  kekVersion = 1,
): Promise<{ dek: Uint8Array; keys: TenantKeys }> {
  const aad = createEncryptionAad(organizationId);
  const existing = await store.get(organizationId);
  if (existing) {
    const dek = await unwrapDek(
      kek,
      existing.wrappedDek,
      existing.wrappedDekIv,
      aad,
    );
    return { dek, keys: existing };
  }
  const dek = createDek();
  const wrapped = await wrapDek(kek, dek, aad);
  const keys: TenantKeys = {
    organizationId,
    wrappedDek: wrapped.wrappedDek,
    wrappedDekIv: wrapped.iv,
    kekVersion,
  };
  await store.put(keys);
  return { dek, keys };
}

export interface StoredTenantKeysRow {
  organization_id: string;
  wrapped_dek: string;
  wrapped_dek_iv: string;
  kek_version: number;
}

export function rowToTenantKeys(row: StoredTenantKeysRow): TenantKeys {
  return {
    organizationId: row.organization_id,
    wrappedDek: row.wrapped_dek,
    wrappedDekIv: row.wrapped_dek_iv,
    kekVersion: row.kek_version,
  };
}

export { newId };

export { nowSeconds };
