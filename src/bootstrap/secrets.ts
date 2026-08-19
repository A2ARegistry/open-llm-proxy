import { Env } from "../../worker-configuration.d";
import { getOrCreateSetting } from "../db/settings";
import { randomBytes, toBase64 } from "../utils/crypto";

/**
 * Runtime secrets for a self-serve deployment.
 *
 * `BETTER_AUTH_SECRET` and `ENCRYPTION_KEY` are no longer required as wrangler
 * secrets. On first boot each is generated (32 random bytes, base64) and
 * persisted in `system_settings`, then read back for every later request.
 * Explicit env overrides still win when provided.
 */

const authSecretCache = new WeakMap<Env, Promise<string>>();
const encryptionKeyCache = new WeakMap<Env, Promise<string>>();

function memoize(
  cache: WeakMap<Env, Promise<string>>,
  env: Env,
  resolve: () => Promise<string>,
): Promise<string> {
  let cached = cache.get(env);
  if (!cached) {
    cached = resolve();
    cache.set(env, cached);
  }
  return cached;
}

/** Better Auth session-signing secret. */
export function getAuthSecret(env: Env): Promise<string> {
  return memoize(authSecretCache, env, () =>
    getOrCreateSetting(env, "app.better_auth_secret", () =>
      toBase64(randomBytes(32)),
    ),
  );
}

/** Envelope-encryption master key (KEK) for tenant credentials. */
export function getEncryptionKey(env: Env): Promise<string> {
  return memoize(encryptionKeyCache, env, () =>
    getOrCreateSetting(env, "app.encryption_key", () =>
      toBase64(randomBytes(32)),
    ),
  );
}

/** Persist new runtime secrets; no-op when already present. */
export async function ensureSecrets(env: Env): Promise<void> {
  await getAuthSecret(env);
  await getEncryptionKey(env);
}
