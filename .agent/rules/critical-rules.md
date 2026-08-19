---
trigger: always_on
---

# Critical Agent Rules

This document defines the most important rules for AI Agents working on this project. These rules MUST be followed strictly at all times to ensure project integrity and security.

## 1. Configuration Model

The env/config-based deployment (PROXY_API_KEY, `config.jsonc`, provider env vars) has been **removed**. Configuration is D1-backed and managed from the dashboard:

1.  **Never add new deployment env vars or config files** for provider secrets or proxy config.
2.  **Runtime secrets** (`BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`) are auto-generated and persisted in D1 (`system_settings`) on first boot; env overrides are optional (see `src/bootstrap/`).
3.  **Provider credentials and API keys** are stored encrypted in D1 and edited via the dashboard (see `src/db/`, `src/api/`).

## 2. Environment Variables & Secrets

1.  **NO Real Secrets**: Never include real API keys, passwords, or any sensitive credentials in code, documentation, or commit messages.
2.  **Request Addition**: If a genuinely new env override is required (e.g., a new bootstrap override), update `worker-configuration.d.ts` accordingly and keep `src/bootstrap/secrets.ts` in sync.

## 3. Type Synchronization

1.  **Run `cf-typegen`**: After changing `wrangler.jsonc` bindings or `worker-configuration.d.ts` env interface expectations, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.
2.  **NO Direct Edit of Typegen Files**: Never manually edit `worker-configuration.d.ts` or other automatically generated files. They will be overwritten during the next generation.

## 4. Code Quality and Verification

1.  **Run Verification**: After any code changes, always run the `@/verify` workflow to ensure that the project still builds, lints, and passes all tests.
2.  **No Placeholders**: Never leave `TODO` comments or placeholder implementations in the final code unless explicitly requested by the user.
