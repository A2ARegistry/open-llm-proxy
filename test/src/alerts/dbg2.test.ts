import { env } from "cloudflare:test";
import { it } from "vitest";

it("dbg2", async () => {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS tenant_settings (organization_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (organization_id, key));`,
  );
  await env.DB.prepare(
    `INSERT INTO tenant_settings (organization_id, key, value, updated_at)
     VALUES (?, 'alerts', ?, ?)
     ON CONFLICT(organization_id, key) DO UPDATE SET value = excluded.value`,
  )
    .bind("org_x", JSON.stringify({ enabled: false }), 123)
    .run();
  const rows = await env.DB.prepare(
    "SELECT key, value FROM tenant_settings",
  ).all();
  console.log("rows:", JSON.stringify(rows.results));
});
