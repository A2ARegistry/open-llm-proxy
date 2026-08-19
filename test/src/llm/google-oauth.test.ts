import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  clearGoogleTokenCache,
  getGoogleAccessToken,
  parseServiceAccount,
} from "~/src/llm/google-oauth";

const SERVICE_ACCOUNT = {
  type: "service_account",
  project_id: "my-project",
  private_key_id: "abc123",
  client_email: "proxy@my-project.iam.gserviceaccount.com",
  client_id: "123",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

async function generateServiceAccountJson(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", key.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  const pemBody =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return JSON.stringify({
    ...SERVICE_ACCOUNT,
    private_key: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`,
  });
}

describe("parseServiceAccount", () => {
  it("rejects non-JSON input", () => {
    expect(() => parseServiceAccount("not json")).toThrow(/JSON/);
  });

  it("requires client_email and private_key", () => {
    expect(() => parseServiceAccount('{"client_email":""}')).toThrow(
      /client_email/,
    );
    expect(() => parseServiceAccount('{"client_email":"a@b"}')).toThrow(
      /private_key/,
    );
  });

  it("requires a PEM private key", () => {
    expect(() =>
      parseServiceAccount('{"client_email":"a@b","private_key":"not-a-pem"}'),
    ).toThrow(/PEM/);
  });

  it("extracts the client email and key", async () => {
    const info = parseServiceAccount(await generateServiceAccountJson());
    expect(info.clientEmail).toBe(SERVICE_ACCOUNT.client_email);
    expect(info.privateKey).toContain("BEGIN PRIVATE KEY");
  });
});

describe("getGoogleAccessToken", () => {
  beforeEach(() => clearGoogleTokenCache());

  it("exchanges a JWT bearer assertion for a token and caches it", async () => {
    const sa = await generateServiceAccountJson();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "ya29.mock", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const token = await getGoogleAccessToken(sa);
    expect(token).toBe("ya29.mock");

    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    const assertion = body.get("assertion") as string;
    expect(body.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const [headerB64, claimsB64] = assertion.split(".");
    const claims = JSON.parse(atob(claimsB64)) as {
      iss: string;
      aud: string;
      scope: string;
    };
    expect(claims.iss).toBe(SERVICE_ACCOUNT.client_email);
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.scope).toContain("cloud-platform");
    expect(JSON.parse(atob(headerB64))).toMatchObject({
      alg: "RS256",
      typ: "JWT",
    });

    // Second call should reuse the cache without another fetch.
    await getGoogleAccessToken(sa);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("surfaces upstream token errors", async () => {
    const sa = await generateServiceAccountJson();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
          }),
        ),
    );
    await expect(getGoogleAccessToken(sa)).rejects.toThrow(
      /OAuth2 access token/,
    );
    vi.unstubAllGlobals();
  });
});
