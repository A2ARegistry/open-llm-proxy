---
description: Steps to add a new runtime secret / bootstrap override
---

Follow these steps in order to add a new optional runtime secret or bootstrap override:

1. Add the new setting key in `src/bootstrap/secrets.ts` (getOrCreate a value in D1 `system_settings` on first boot).
2. Add the corresponding optional env override type to `worker-configuration.d.ts` (and to `wrangler.jsonc` `vars` if you want a default).
3. Reference it via `getAuthFor` / the bootstrap helper rather than reading `env` directly in route handlers.
4. Regenerate types: `npm run cf-typegen`.
