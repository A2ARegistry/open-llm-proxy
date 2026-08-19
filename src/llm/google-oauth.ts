/**
 * Google OAuth2 service-account authentication.
 *
 * Vertex AI's token-based auth requires an OAuth2 access token. We mint one
 * server-side from the tenant's service-account JSON using the standard JWT
 * bearer assertion flow (RS256), and cache it in the isolate until it expires.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_TTL_SECONDS = 3600;
const REFRESH_SKEW_SECONDS = 120;

export interface ServiceAccountInfo {
  clientEmail: string;
  privateKey: string;
}

export function parseServiceAccount(json: string): ServiceAccountInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Service account must be a valid JSON document");
  }
  const obj = parsed as {
    client_email?: unknown;
    private_key?: unknown;
  };
  if (typeof obj.client_email !== "string" || obj.client_email.length === 0) {
    throw new Error("Service account JSON is missing 'client_email'");
  }
  if (typeof obj.private_key !== "string" || obj.private_key.length === 0) {
    throw new Error("Service account JSON is missing 'private_key'");
  }
  if (
    !obj.private_key.includes("BEGIN") ||
    !obj.private_key.includes("PRIVATE KEY")
  ) {
    throw new Error(
      "Service account 'private_key' must be a PEM-encoded private key",
    );
  }
  return { clientEmail: obj.client_email, privateKey: obj.private_key };
}

function b64url(data: string | Uint8Array): string {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

async function signJwtAssertion(
  info: ServiceAccountInfo,
  now: number,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: info.clientEmail,
      scope: CLOUD_PLATFORM_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  );
  const unsigned = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(info.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}

interface MintedToken {
  token: string;
  expiresAt: number;
}

/** Best-effort isolate-local cache; an eviction just causes a re-mint. */
const tokenCache = new Map<string, MintedToken>();

/**
 * Exchange a service-account JSON for a short-lived OAuth2 access token,
 * reusing a cached token when one is still valid.
 */
export async function getGoogleAccessToken(
  serviceAccountJson: string,
): Promise<string> {
  const info = parseServiceAccount(serviceAccountJson);

  const cached = tokenCache.get(info.clientEmail);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + REFRESH_SKEW_SECONDS) {
    return cached.token;
  }

  const assertion = await signJwtAssertion(info, now);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  } | null;
  if (!res.ok || !body?.access_token) {
    const detail = body?.error_description ?? `HTTP ${res.status}`;
    throw new Error(`Failed to obtain a Google OAuth2 access token: ${detail}`);
  }

  const expiresIn = Math.min(
    Number(body.expires_in ?? TOKEN_TTL_SECONDS),
    TOKEN_TTL_SECONDS,
  );
  const minted = { token: body.access_token, expiresAt: now + expiresIn };
  tokenCache.set(info.clientEmail, minted);
  return minted.token;
}

/** Test helper: clear the isolate-local token cache. */
export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}
