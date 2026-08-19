import { Env } from "../../worker-configuration.d";

/** Read a `system_settings` row. */
export async function getSetting(
  env: Env,
  key: string,
): Promise<string | undefined> {
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = ?",
  )
    .bind(key)
    .first<{ value: string | null }>();
  return row?.value ?? undefined;
}

/** Write a `system_settings` row (upsert). */
export async function setSetting(
  env: Env,
  key: string,
  value: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%s', 'now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at`,
  )
    .bind(key, value)
    .run();
}

/**
 * Return the stored value for `key`, generating and persisting it on first
 * use. Safe under concurrent isolates: the INSERT is no-op'd by the primary
 * key conflict, and every reader falls back to the persisted value.
 */
export async function getOrCreateSetting(
  env: Env,
  key: string,
  generate: () => string,
): Promise<string> {
  const existing = await getSetting(env, key);
  if (existing !== undefined) return existing;
  const value = generate();
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, strftime('%s', 'now'))
     ON CONFLICT(key) DO NOTHING`,
  )
    .bind(key, value)
    .run();
  return getSetting(env, key) ?? value;
}
