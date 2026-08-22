import {
  clearMustChangePassword,
  ensureInitialAdmin,
  getInitialAdmin,
  InitialAdminInfo,
} from "./admin";
import { ensureSecrets } from "./secrets";

const bootstrapCache = new WeakMap<Env, Promise<void>>();

/**
 * One-time self-serve initialization for a fresh deployment:
 * 1. Generate + persist runtime secrets (auth secret, encryption key).
 * 2. Seed the default admin account + organization.
 *
 * Memoized per isolate so the cost is a single `users` lookup per request
 * afterwards; the seed itself is idempotent under concurrent first requests.
 */
export function ensureBootstrapped(env: Env): Promise<void> {
  let promise = bootstrapCache.get(env);
  if (!promise) {
    promise = doBootstrap(env).catch(async (err) => {
      bootstrapCache.delete(env);
      throw err;
    });
    bootstrapCache.set(env, promise);
  }
  return promise;
}

async function doBootstrap(env: Env): Promise<void> {
  await ensureSecrets(env);
  await ensureInitialAdmin(env);
}

export interface BootstrapStatus {
  initialized: boolean;
  initialAdmin: InitialAdminInfo | undefined;
  defaultCredentials: { email: string; password: string } | undefined;
}

/** Current bootstrap state, shown to unauthenticated visitors on the login page. */
export async function bootstrapStatus(env: Env): Promise<BootstrapStatus> {
  const initialAdmin = await getInitialAdmin(env);
  return {
    initialized: Boolean(initialAdmin),
    initialAdmin,
    defaultCredentials: initialAdmin?.mustChangePassword
      ? {
          email: (env as any).INITIAL_ADMIN_EMAIL || initialAdmin.email,
          password: (env as any).INITIAL_ADMIN_PASSWORD || "AwesomeProxy!!",
        }
      : undefined,
  };
}

export { clearMustChangePassword };

export type { InitialAdminInfo };
