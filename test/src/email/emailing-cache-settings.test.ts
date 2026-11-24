// [fork] Supply-chain fix: the third-party EmailingCacheDO must only load
// system_email.* settings, never the gateway's own secrets.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL DEFAULT 0);",
  );
  await env.DB.exec(
    "INSERT OR REPLACE INTO system_settings (key, value) VALUES ('app.better_auth_secret', 'TOP-SECRET'), ('system_email.from_address', 'noreply@example.com');",
  );
});

describe("EmailingCacheDO settings", () => {
  it("loads only system_email.* rows", async () => {
    const stub = env.EMAIL_TEMPLATE_CACHE.get(
      env.EMAIL_TEMPLATE_CACHE.idFromName("settings-test"),
    );
    const res = await stub.fetch("http://do/settings/get?key=system");
    const body = (await res.json()) as { settings: Record<string, string> };

    expect(JSON.stringify(body)).not.toContain("TOP-SECRET");
    expect(Object.keys(body.settings)).toEqual(["system_email.from_address"]);
  });
});
