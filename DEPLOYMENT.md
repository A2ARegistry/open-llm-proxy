# Deployment Guide: Cloudflare Dashboard Auto-Deploy (Git CI/CD)

This guide walks you through deploying **Open LLM Proxy** via the **Cloudflare Dashboard (Workers Builds / Git Integration)**.

Because this is a public open-source repository, **you do not need to commit any sensitive domain names, account credentials, or production resource IDs into `wrangler.jsonc` or Git history.** Everything private is securely configured in your Cloudflare Dashboard.

---

## Architecture Overview

- **Git Repository**: Contains only generic configuration and placeholders (`00000000-0000-...`).
- **Cloudflare Dashboard (Workers & Pages)**: Connects to your GitHub repository and automatically builds and deploys on every push (`git push`).
- **Cloudflare Portal Overrides**: Production D1 databases, KV namespaces, environment variables, custom domains, and secrets are bound in the Cloudflare Dashboard UI, taking precedence over `wrangler.jsonc` during the build.

---

## Step 1: Create Production Cloudflare Resources (One-Time)

In the [Cloudflare Dashboard](https://dash.cloudflare.com/):

### 1.1 Create D1 Database

1. Go to **Storage & Databases** → **D1 SQL Database**.
2. Click **Create Database**.
3. Name it `open-llm-proxy-prod`.

### 1.2 Create KV Namespace

1. Go to **Storage & Databases** → **KV**.
2. Click **Create Namespace**.
3. Name it `SESSION_CACHE_PROD` (or `open-llm-proxy-sessions`).

### 1.3 Apply Initial Database Migrations

Run the D1 migrations against your remote database once using Wrangler CLI (or D1 Console in Dashboard):

```bash
npx wrangler d1 migrations apply open-llm-proxy-prod --remote
```

_(Or use `npx wrangler d1 migrations apply DB --remote`)_

---

## Step 2: Connect GitHub Repository to Cloudflare Workers

1. Go to **Compute (Workers & Pages)** → **Create Application**.
2. Select the **Workers** tab (or **Pages** if connecting via Builds) → click **Connect to Git**.
3. Select your GitHub account and the `open-llm-proxy` repository.
4. Select the production branch (e.g. `main`).

---

## Step 3: Configure Build Settings

In the **Build settings** section:

- **Framework preset**: `None`
- **Build command**:
  ```bash
  npm run build && npm run build:dashboard
  ```
- **Deploy command**: `npx wrangler deploy` (default)
- **Root directory**: `/`

---

## Step 4: Configure Bindings & Environment Variables in Dashboard

Once the project is connected, go to your Worker's **Settings**:

### 4.1 Bindings (Settings → Bindings)

Link the real Cloudflare resources to the binding names used in code:

1. **D1 Database Binding**:
   - Variable name: `DB`
   - D1 Database: Select `open-llm-proxy-prod` from the dropdown.

2. **KV Namespace Binding**:
   - Variable name: `SESSION_CACHE`
   - KV Namespace: Select `SESSION_CACHE_PROD` from the dropdown.

3. **Assets Binding**:
   - Handled automatically by `wrangler.jsonc` (`./dashboard/dist` → `ASSETS`).

4. **Durable Objects**:
   - Durable Objects (`RateLimiter`, `ResponseCache`, `SessionManager`, `MetricsBuffer`, `EmailingCacheDO`) are automatically bound and provisioned from the project exports.

---

### 4.2 Environment Variables (Settings → Variables and Secrets)

Add your production environment variables (plaintext):

| Variable Name               | Production Value (Example)   | Description                                  |
| --------------------------- | ---------------------------- | -------------------------------------------- |
| `ENVIRONMENT`               | `production`                 | Deployment environment                       |
| `BASE_URL`                  | `https://api.yourdomain.com` | Public base URL for the API & Proxy          |
| `DASHBOARD_URL`             | `https://api.yourdomain.com` | URL where the admin UI is hosted             |
| `APP_NAME`                  | `Open LLM Proxy`             | Application name displayed in UI/emails      |
| `RATE_LIMITER_SHARDS`       | `8`                          | Number of DO shards for tenant rate limiting |
| `METRICS_BUFFER_SHARDS`     | `8`                          | Number of DO shards for request buffering    |
| `SESSION_CACHE_TTL_SECONDS` | `3600`                       | Session cache TTL in seconds                 |

---

### 4.3 Secrets (Settings → Variables and Secrets → Add Secret)

Add any encrypted credentials required:

- `JWT_SECRET` (if customized)
- Any default provider keys you want encrypted at rest

---

## Step 5: Configure Custom Domain & Routing

1. In your Worker dashboard, go to **Settings** → **Triggers** (or **Domains & Routes**).
2. Click **Add** → **Custom Domain**.
3. Enter your custom domain (e.g. `api.yourdomain.com`).
4. Cloudflare will automatically provision the DNS records and SSL/TLS certificates.

---

## Step 6: Verify Deployment

1. Visit `https://api.yourdomain.com` in your browser — you should see the Open LLM Proxy Admin Dashboard.
2. Complete initial admin onboarding / registration.
3. Call the health check endpoint:
   ```bash
   curl https://api.yourdomain.com/api/health
   ```
4. Future commits to `main` will automatically trigger a new deployment without leaking any production secrets or private domain names to Git!
