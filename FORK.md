# Fork notes

This is a fork of [A2ARegistry/open-llm-proxy](https://github.com/A2ARegistry/open-llm-proxy),
based on upstream `main` at `961f736` ("Fix CI problem"). It adds a way to reach a
self-hosted, OpenAI-compatible server that has no public address, through a
Cloudflare Tunnel and a [Workers VPC service](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/).

Fork changes are kept small and marked `[fork] W<n>` in the code, so upstream
merges stay easy. New behaviour lives in new files where possible.

## Changes

| Item                     | What                                                                                                                                                                                                                                                                                                                                                                  | Files                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 VPC transport         | Providers can set `transport: "vpc"` and `vpcBinding`; requests then go through that Worker binding instead of the global `fetch`. Used by chat completions (Route 3), `/v1/models`, the dashboard connection test and model auto-detect.                                                                                                                             | `src/llm/transport.ts`, `src/llm/transport-error.ts` (new); `src/llm/v1-provider.ts`, `src/requests/chat_completions_v2.ts`, `src/requests/models_v2.ts`, `src/llm/provider-test.ts`, `src/api/provider-config.ts`, `dashboard/src/pages/ProvidersPage.tsx`, `wrangler.jsonc`, `worker-configuration.d.ts` |
| W1 access control        | `VPC_BINDINGS="NAME:org_a\|org_b,OTHER:*"`: a binding is usable only by the listed organizations (bare `NAME` = nobody). Saving a vpc provider is rejected for other organizations.                                                                                                                                                                                   | `src/llm/transport.ts`, `src/api/provider-config.ts`                                                                                                                                                                                                                                                       |
| W1 endpoint pinning      | A vpc provider can only reach `/v1/chat/completions`, `/v1/models` and `/v1/embeddings`: base URL must be `scheme://host:port`, paths must be exactly those, and the final URL is checked before every vpc fetch. The connection test and model auto-detect never echo a vpc upstream's body or error text.                                                           | `src/llm/transport.ts`, `src/llm/v1-provider.ts`, `src/llm/provider-test.ts`, `dashboard/src/pages/ProvidersPage.tsx`                                                                                                                                                                                      |
| W2 keyless providers     | Tests that a custom provider with zero keys sends no `Authorization` header. Fixes an upstream bug: with zero keys a retryable 5xx body was consumed before being returned ("Body has already been used").                                                                                                                                                            | `src/llm/v1-provider.ts`                                                                                                                                                                                                                                                                                   |
| W3 `injectBody`          | Provider setting: a JSON object (max 4 KB, no `model`/`messages`/`stream`) merged into the upstream chat body; the client's values win, `stream_options` is deep-merged on streaming requests only. Dashboard field "Inject into request body".                                                                                                                       | `src/llm/inject-body.ts` (new), `src/requests/chat_completions_v2.ts`, `src/api/provider-config.ts`, `dashboard/src/pages/ProvidersPage.tsx`                                                                                                                                                               |
| W7 upstream health       | The 5-minute cron probes `GET /health` on every `VPC_BINDINGS` binding and stores `{status, version, checkedAt, latencyMs}` in `SESSION_CACHE` (`health:<NAME>`). `GET /api/health/upstreams` (org members) and a dashboard badge show it.                                                                                                                            | `src/health/upstream-health.ts`, `src/api/health.ts`, `dashboard/src/components/UpstreamHealthBadges.tsx` (new); `src/index.ts`, `src/app.ts`, `dashboard/src/pages/DashboardPage.tsx`                                                                                                                     |
| W8 provider-wide pricing | `model_pricing` rows with `model = '*'` price every model of a provider (exact rows still win, one query).                                                                                                                                                                                                                                                            | `src/metrics/cost-tracker.ts`                                                                                                                                                                                                                                                                              |
| W9 deploy options        | `--vpc-service-id`, `--vpc-allow`, `--custom-domain`, `--zero-price-provider` for `npm run deploy`, or env `VPC_SERVICE_IDS`, `VPC_ALLOW`, `CUSTOM_DOMAIN`, `ZERO_PRICE_PROVIDERS` for Git builds.                                                                                                                                                                    | `scripts/fork-deploy.mjs` (new), `scripts/deploy-production.mjs`, `DEPLOYMENT.md` (section 2.5)                                                                                                                                                                                                            |
| W10 modal overflow       | Dialogs are capped at the viewport height and scroll their body; header and footer stay visible. Before, a tall form (custom provider with Advanced settings open) pushed Save below the window with no way to reach it.                                                                                                                                              | `dashboard/src/components/ui.tsx`                                                                                                                                                                                                                                                                          |
| Password hashing         | scrypt (N=16384, r=16, p=1, 64-byte key; `scrypt:N:r:p:salt:hash`) for dashboard passwords, via content-auth's `emailAndPassword.password` hook (`useCloudflareNativeHashing: false`) and the admin bootstrap. Existing `pbkdf2:` hashes still verify. About 1.2 s of CPU per sign-in or password change; API keys are unaffected.                                    | `src/auth/password-hashing.ts` (new), `src/auth/setup.ts`, `src/bootstrap/admin.ts`, `package.json` (`@noble/hashes` pinned), `vitest.config.mts` (test timeout)                                                                                                                                           |
| Dashboard dark mode      | Follows the OS `prefers-color-scheme`; no toggle. Redefines Tailwind palette tokens (grays/slates inverted, colour tints darkened, text shades lightened) and content-auth's `--ca-*` vars. A few class rules cover `bg-white`, indigo/red text that shares a token with white-text buttons, dark islands (code sample, tooltips) and Recharts. No component changes. | `dashboard/src/dark.css` (new), `dashboard/src/index.css` (one `@import`)                                                                                                                                                                                                                                  |
| Supply chain             | `@contentgrowth/content-auth` and `@contentgrowth/content-emailing` pinned to exact versions; email cache scoped to `system_email.` settings. Review notes below.                                                                                                                                                                                                     | `package.json`, `package-lock.json`, `wrangler.jsonc`                                                                                                                                                                                                                                                      |

New tests: `test/src/llm/transport.test.ts`, `test/src/llm/inject-body.test.ts`,
`test/src/requests/chat_completions_v2.test.ts`, `test/src/requests/models_v2.test.ts`,
`test/src/health/upstream-health.test.ts`, `test/src/metrics/model-pricing.test.ts`,
`test/src/scripts/fork-deploy.test.ts`, plus `[fork]` sections appended to existing
test files.

## Decisions

- **Content retention follows upstream.** Response cache and traces stay opt-in
  per provider/tenant, as upstream ships them, including for vpc providers. Turning
  on `trace` for a provider prints full prompts and completions to Workers Logs.
- **No `usage_missing` flag (W4 dropped).** A stream that ends without a usage
  chunk records no token counts; for the self-hosted server this is limited to
  client disconnects and crashes once `stream_options.include_usage` is sent
  (via `injectBody`) or the server sends usage by default.
- **No timeouts added (W5).** The upstream call is aborted only by the client's
  `request.signal`; no middleware, rate limiter or metrics buffer sets a
  wall-clock limit (`limits.cpu_ms` is CPU time). The app has no body-size
  limit of its own. Long prefills rely on the upstream's SSE keepalives.
- **W6 privacy hardening reverted** in favour of upstream defaults (see above);
  the access-control and endpoint-pinning pieces stay.

## Merging upstream

```bash
git fetch upstream
git merge upstream/main
npx wrangler types   # worker-configuration.d.ts is generated; regenerate on conflict
npm run build:dashboard && npm test
```

- Conflicts are most likely in `src/requests/chat_completions_v2.ts`,
  `src/llm/provider-test.ts`, `src/api/provider-config.ts` and
  `dashboard/src/pages/ProvidersPage.tsx`. Search for `[fork]` to find every hunk.
- `dashboard/tsconfig.tsbuildinfo` is a tracked build artifact upstream; take
  upstream's copy (`git checkout upstream/main -- dashboard/tsconfig.tsbuildinfo`).
- Tests need the dashboard built first (`npm run build:dashboard`): the SPA test
  reads `dashboard/dist`.
- Upstream's 100% coverage threshold is not met by upstream itself (about 60%);
  `npm test` does not enforce it.

## Supply-chain review

`@contentgrowth/content-auth` 0.5.6 and `@contentgrowth/content-emailing` 0.8.5
(MIT, no install scripts) were read once on 2026-11-24 and pinned to exact
versions. Resolved dependencies: better-auth 1.6.29, drizzle-orm 0.45.2,
hono 4.13.2, marked 17.0.6, mustache 4.2.0; `cac` is used only by their CLIs,
never by the Worker. Re-review on every upgrade.

- **No signs of malice:** no telemetry, eval, remote code, obfuscation or
  backdoors. Outbound calls go only to Turnstile (if a secret is set) and the
  configured email provider (MailChannels, SendGrid, Resend, SendPulse).
- **Fixed: secrets loaded by the email cache.** `EmailingCacheDO` reads its
  settings prefix from `EMAIL_SETTINGS_KEY_PREFIX` (default empty), so it ran
  `SELECT * FROM system_settings`, pulling the auth secret and encryption key
  into a cached email-settings object. `wrangler.jsonc` now sets
  `EMAIL_SETTINGS_KEY_PREFIX=system_email.` in both environments
  (`test/src/email/emailing-cache-settings.test.ts`).
- **Known, not fixed (upstream behaviour):**
  - System email settings saved in the dashboard are not applied when the email
    cache is bound: the cache returns `system_email.`-prefixed keys that
    `EmailService` does not strip.
  - Markdown from user-supplied names (sign-up name, organization, inviter) is
    rendered in auth emails, so links can be injected; HTML is escaped. Low risk
    here: sign-up sits behind Cloudflare Access with `/api/*`.
  - Fixed: passwords used PBKDF2-SHA256 at 100k iterations; now scrypt (see
    Changes). Workers caps native PBKDF2 at 100k in production
    ([workerd#1346](https://github.com/cloudflare/workerd/issues/1346)) and
    pure-JS PBKDF2 at 600k costs ~8 s of CPU.
  - Sign-up reveals whether an email is registered; Turnstile is skipped unless
    `TURNSTILE_SECRET` is set.
  - Email footers default to placeholder branding (`https://app.example.com`).
