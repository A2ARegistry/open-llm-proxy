import { Buffer } from "node:buffer";

export function toBase64(data: ArrayBuffer | Uint8Array | string): string {
  if (typeof data === "string")
    return Buffer.from(data, "utf8").toString("base64");
  return Buffer.from(data).toString("base64");
}

export function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
  const input =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return bytesToHex(digest);
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function aes256GcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array | string,
  additionalData?: Uint8Array,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const data =
    typeof plaintext === "string"
      ? new TextEncoder().encode(plaintext)
      : plaintext;
  const iv = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      cryptoKey,
      data,
    ),
  );
  return { ciphertext, iv };
}

export async function aes256GcmDecrypt(
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      cryptoKey,
      ciphertext,
    ),
  );
  return plaintext;
}

/** PBKDF2-SHA256 with the WebCrypto surface (workerd-safe). */
export async function pbkdf2Sha256(
  password: string,
  salt: Uint8Array,
  iterations: number,
  keyLength = 32,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    keyMaterial,
    keyLength * 8,
  );
  return new Uint8Array(bits);
}

export function newUuid(): string {
  return crypto.randomUUID();
}

export function newId(prefix: string): string {
  return `${prefix}_${newUuid().replace(/-/g, "")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function safeJsonParse<T>(
  raw: string | null | undefined,
  fallback: T,
): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function maskKey(key: string): string {
  if (key.length <= 8) return `${"*".repeat(key.length)}`;
  return `${key.slice(0, 8)}${"*".repeat(Math.min(key.length - 8, 12))}`;
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}
