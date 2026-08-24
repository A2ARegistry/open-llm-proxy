# Deployment Guide: Open LLM Proxy on Cloudflare

This guide provides step-by-step instructions for deploying **Open LLM Proxy** to Cloudflare Workers.

Two supported paths:

- **Option A — From your terminal (recommended)**: you run one command locally and pass your private resource IDs on the command line. Nothing sensitive ever touches Git.
- **Option B — Cloudflare Dashboard with GitHub integration**: Cloudflare builds and deploys on every push; you provide the private IDs once as build environment variables in the dashboard.

**Important**: This is an open-source project, so `wrangler.jsonc` contains only placeholder development/local settings (IDs like `00000000-…`). **Never commit production credentials, database IDs, or domains to Git.** Both deploy paths inject your real IDs at deploy time — they are never stored in the repo.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Create Cloudflare Resources](#step-1-create-cloudflare-resources)
3. [Deploy from Your Terminal (Recommended)](#step-2-deploy-from-your-terminal-recommended)
4. [Connect GitHub and Deploy](#step-3-connect-github-and-deploy)
5. [Apply Database Migrations](#step-4-apply-database-migrations)
6. [Configure Production Settings](#step-5-configure-production-settings)
7. [Configure Custom Domain](#step-6-configure-custom-domain-optional)
8. [Verify Deployment](#step-7-verify-deployment)
9. [Continuous Deployment](#step-8-continuous-deployment)

---

## Prerequisites

- Cloudflare account (free tier works)
- GitHub repository with this code (forked or your own)
- GitHub account connected to Cloudflare (one-time OAuth setup)

**Note**: Node.js 22 is automatically configured via the `.node-version` file in the repository.

---

## Step 1: Create Cloudflare Resources

All resources must be created in your Cloudflare account before deployment.

### 1.1 Create D1 Database

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **D1 SQL Databases**
3. Click **Create Database**
4. Name: `open-llm-proxy` (or any name you prefer)
5. Click **Create**
6. **Keep this tab open** - you'll need to copy the Database ID later

### 1.2 Create KV Namespace

1. In a new tab, go to **Workers & Pages** → **KV**
2. Click **Create Namespace**
3. Name: `open-llm-proxy-sessions` (or any name you prefer)
4. Click **Add**
5. **Keep this tab open** - you'll need to select this namespace later

---

## Step 2: Deploy from Your Terminal (Recommended)

`npm run deploy` is a wrapper (`scripts/deploy-production.mjs`) that injects your real resource IDs into a temporary, git-ignored config, applies D1 migrations, and deploys — all in one command.

### 2.1 Login and Collect Your IDs

```bash
# One-time login (opens a browser)
npx wrangler login

# Find your D1 database id
npx wrangler d1 list

# Find your KV namespace id
npx wrangler kv namespace list
```

(You created both resources in Step 1; the dashboard also shows the IDs.)

### 2.2 Deploy

```bash
npm run deploy -- --d1 <D1_DATABASE_ID> --kv <KV_NAMESPACE_ID>
```

> **Note the `--`** — npm requires it before flags so they reach the script instead of being swallowed by npm itself.

Example:

```bash
npm run deploy -- \
  --d1 4f2a1b3c-9d8e-4f01-a2b3-c4d5e6f70819 \
  --kv 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

The command will:

1. Build TypeScript + the admin dashboard (`npm run build`)
2. Apply all pending D1 migrations to your remote database
3. Generate `wrangler.production.local.json` (git-ignored, deleted afterwards) with your real IDs under `env.production`
4. Run `wrangler deploy --env production --config wrangler.production.local.json`

When it finishes you get a `*.workers.dev` URL (add a custom domain later, see Step 6).

### 2.3 Useful Flags

| Flag               | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `--dry-run`        | Show what would run without changing anything                        |
| `--migrate-only`   | Only apply D1 migrations and exit                                    |
| `--skip-build`     | Skip `npm run build` (when already built)                            |
| `--skip-migrate`   | Deploy without touching migrations                                   |
| `--d1-name <name>` | Override `database_name` if yours differs from `open-llm-proxy-prod` |

So `npm run migrate` alone becomes:

```bash
npm run migrate -- --d1 <D1_DATABASE_ID>
```

Anything after the known flags is forwarded to `wrangler deploy`, e.g. `npm run deploy -- --d1 … --kv … --keep-vars`.

### 2.4 Alternative: Environment Variables (CI-friendly)

Instead of CLI flags, the wrapper also reads `D1_DATABASE_ID` and `KV_NAMESPACE_ID` from the environment:

```bash
D1_DATABASE_ID=4f2a… KV_NAMESPACE_ID=1a2b… npm run deploy
```

This is exactly how **Option B** (GitHub integration) works — see Step 3.

---

## Step 3: Connect GitHub and Deploy

### 3.1 Create Worker from Git

1. In Cloudflare Dashboard, go to **Workers & Pages**
2. Click **Create Application**
3. Click the **Workers** tab
4. Click **Connect to Git**

### 3.2 Connect GitHub Repository

1. If first time: Click **Connect GitHub** and authorize Cloudflare
2. Select your GitHub account
3. Find and select the `open-llm-proxy` repository (or your fork)
4. Click **Begin setup**

### 3.3 Configure Build Settings

In the build configuration screen:

**Production branch**: `main` (or your default branch)

**Build configurations**:

- **Build command**: Leave blank (the deploy command handles everything)
- **Build output directory**: Leave blank
- **Root directory**: `/` (leave as default)

**Deploy command**:

```bash
npm ci && npm run deploy
```

Because Git builds cannot pass CLI flags, provide your private resource IDs as **build environment variables** (same page, **Variables** section):

| Variable          | Value                     |
| ----------------- | ------------------------- |
| `D1_DATABASE_ID`  | your real D1 database id  |
| `KV_NAMESPACE_ID` | your real KV namespace id |

The deploy wrapper reads these automatically. They are stored in the Cloudflare build settings — never in the repository.

**Note**: The `npm run deploy` script will:

1. Build TypeScript and dashboard (`npm run build`)
2. Apply database migrations to your D1 database
3. Generate a temporary git-ignored config with your IDs and deploy (`wrangler deploy --env production`)

**Note**: Node.js 22 is automatically used based on the `.node-version` file in the repository.

Click **Save and Deploy**

### 3.4 First Deployment

With `D1_DATABASE_ID` and `KV_NAMESPACE_ID` set, the first deployment should succeed end-to-end: it creates the schema via migrations and binds all resources from the generated config.

If you skipped the environment variables, the deploy fails with a message like:

```
✖ Missing real D1 database id. Pass --d1 <id> (or set D1_DATABASE_ID).
```

Add the variables under **Settings → Builds & deployments → Variables**, then retry the deployment.

---

## Step 4: Apply Database Migrations (Dashboard Path Only)

> Skip this step if you deployed via **Step 2** — the deploy wrapper applies migrations automatically. It is only needed for the dashboard/Git path if you removed `D1_DATABASE_ID`/`KV_NAMESPACE_ID`, or for applying migrations to an already-deployed database.

Before the worker can run, you need to create the database schema.

### Option A: Using Wrangler CLI (Recommended)

If you have Node.js and npm installed locally:

```bash
# Clone the repository (if not already done)
git clone https://github.com/YOUR_USERNAME/open-llm-proxy.git
cd open-llm-proxy

# Install dependencies
npm install

# Login to Cloudflare (one-time)
npx wrangler login

# Apply migrations (the wrapper injects your database id)
npm run migrate -- --d1 <D1_DATABASE_ID>
```

Expected output:

```
Migrations to be applied:
┌───────────────────────────┐
│ 0001_auth.sql             │
│ 0002_email.sql            │
│ 0003_app.sql              │
└───────────────────────────┘
✔ About to apply 3 migration(s)
🌀 Executing on remote database open-llm-proxy:
✅ Successfully applied 3 migration(s)!
```

### Option B: Using D1 Console in Dashboard

If you don't have CLI access:

1. Go to your D1 database in the Cloudflare Dashboard
2. Click the **Console** tab
3. Copy the contents of `migrations/0001_auth.sql` from GitHub
4. Paste into the console and click **Execute**
5. Repeat for `0002_email.sql` and `0003_app.sql` in order

---

## Step 5: Configure Production Settings

> **Note**: If you deployed via the deploy wrapper (Step 2 or Step 3), all resource bindings below (D1 `DB`, KV `SESSION_CACHE`, and the five Durable Objects) plus the production variables from `wrangler.jsonc` are applied **automatically** at deploy time. You only need this step to add **secrets** (5.4), or to override defaults such as your real `BASE_URL` / `DASHBOARD_URL` — see 5.3.

Now configure any remaining settings on the deployed worker.

### 5.1 Access Worker Settings

1. Go to **Workers & Pages**
2. Click on your worker (e.g., `open-llm-proxy`)
3. Click **Settings** tab
4. Click **Variables and Secrets** in the left sidebar

### 5.2 Add Resource Bindings

#### D1 Database Binding

> Only needed if you deploy **without** the deploy wrapper. The wrapper configures this automatically from your `--d1` id.

1. Scroll to **D1 Database Bindings**
2. Click **Add binding**
3. **Variable name**: `DB` (must be exactly this)
4. **D1 database**: Select your database (e.g., `open-llm-proxy`)
5. Click **Save**

#### KV Namespace Binding

> Only needed if you deploy **without** the deploy wrapper.

1. Scroll to **KV Namespace Bindings**
2. Click **Add binding**
3. **Variable name**: `SESSION_CACHE` (must be exactly this)
4. **KV namespace**: Select your namespace (e.g., `open-llm-proxy-sessions`)
5. Click **Save**

#### Durable Object Bindings

> Always configured automatically from the `durable_objects` section of `wrangler.jsonc` — no manual dashboard setup is required on any supported path. Listed here for reference:

| Variable Name          | Durable Object Class Name |
| ---------------------- | ------------------------- |
| `RATE_LIMITER`         | `RateLimiter`             |
| `RESPONSE_CACHE`       | `ResponseCache`           |
| `SESSION_MANAGER`      | `SessionManager`          |
| `METRICS_BUFFER`       | `MetricsBuffer`           |
| `EMAIL_TEMPLATE_CACHE` | `EmailingCacheDO`         |

### 5.3 Add Environment Variables

The production values from `env.production.vars` in `wrangler.jsonc` are applied at every deploy. To override them with your real domains without editing the public repo, either:

- Set them in the dashboard (**Settings → Variables and Secrets**), then deploy with `--keep-vars` so wrangler preserves dashboard values:
  ```bash
  npm run deploy -- --d1 <id> --kv <id> --keep-vars
  ```
- Or keep them only in the dashboard for the Git-integration path (set `--keep-vars` in the Deploy command there too: `npm ci && npm run deploy -- --keep-vars`).

Values you will typically want to override:

| Variable        | Value (Example)                | Description                         |
| --------------- | ------------------------------ | ----------------------------------- |
| `BASE_URL`      | `https://proxy.yourdomain.com` | Your public API URL                 |
| `DASHBOARD_URL` | `https://proxy.yourdomain.com` | Admin dashboard URL (same as above) |

**Optional Variables** (defaults are usually fine):

| Variable                    | Value (Example)          | Description                                  |
| --------------------------- | ------------------------ | -------------------------------------------- |
| `APP_NAME`                  | `Open LLM Proxy`         | App name in UI and emails                    |
| `RATE_LIMITER_SHARDS`       | `8`                      | Number of rate limiter shards (default: 4)   |
| `METRICS_BUFFER_SHARDS`     | `8`                      | Number of metrics buffer shards (default: 4) |
| `SESSION_CACHE_TTL_SECONDS` | `3600`                   | Session cache TTL in seconds (default: 60)   |
| `EMAIL_PROVIDER`            | `console`                | Email provider (see options below)           |
| `EMAIL_FROM_NAME`           | `Open LLM Proxy`         | Email sender name                            |
| `EMAIL_FROM_ADDRESS`        | `noreply@yourdomain.com` | Email sender address                         |

**Email Provider Options**:

- `console` - Logs emails to console (recommended for testing)
- `mailchannels` - Uses Cloudflare MailChannels (free)
- `resend` - Requires `RESEND_API_KEY` secret
- `sendgrid` - Requires `SENDGRID_API_KEY` secret
- `sendpulse` - Requires `SENDPULSE_CLIENT_ID` and `SENDPULSE_CLIENT_SECRET` secrets

**Important**: Click **Save** after adding all variables.

### 5.4 Add Secrets (If Using Email)

If you set `EMAIL_PROVIDER` to `resend`, `sendgrid`, or `sendpulse`:

1. Scroll to **Environment Variables** section
2. Click **Add variable**
3. Enter the **Variable name** (e.g., `RESEND_API_KEY`)
4. Enter the **Value** (your API key)
5. Select **Encrypt** checkbox
6. Click **Save**

Common secrets:

| Secret Name               | When Required            |
| ------------------------- | ------------------------ |
| `RESEND_API_KEY`          | EMAIL_PROVIDER=resend    |
| `SENDGRID_API_KEY`        | EMAIL_PROVIDER=sendgrid  |
| `SENDPULSE_CLIENT_ID`     | EMAIL_PROVIDER=sendpulse |
| `SENDPULSE_CLIENT_SECRET` | EMAIL_PROVIDER=sendpulse |

---

## Step 6: Configure Custom Domain (Optional)

To use your own domain instead of `*.workers.dev`:

1. Go to your Worker → **Settings** → **Domains & Routes**
2. Click **Add** next to **Custom Domains**
3. Enter your domain or subdomain: `proxy.yourdomain.com`
4. Click **Add Domain**

Cloudflare will automatically:

- Add the required DNS records (if your domain uses Cloudflare DNS)
- Provision SSL/TLS certificates
- Enable HTTPS

**Note**: Your domain must use Cloudflare nameservers for automatic DNS setup.

---

## Step 7: Verify Deployment

### 7.1 Trigger a New Deployment

After configuring all bindings and variables:

1. Go to **Deployments** tab
2. Click **Retry deployment** on the failed deployment

OR

1. Make a small commit to your GitHub repository
2. Push to the `main` branch
3. Cloudflare will automatically build and deploy

### 7.2 Check Deployment Status

1. Go to **Deployments** tab
2. Wait for the deployment to complete (green checkmark)
3. You should see "Deployment successful"

### 7.3 Access the Dashboard

Visit your deployment URL:

```
https://proxy.yourdomain.com
# or
https://open-llm-proxy.YOUR-SUBDOMAIN.workers.dev
```

You should see the Open LLM Proxy admin dashboard login page.

### 7.4 Complete Initial Setup

1. On first visit, you'll see the bootstrap/setup page
2. Note the default admin credentials (shown only once)
3. Log in with the default credentials
4. **Immediately change the admin password** in settings

### 7.5 Test the API

Check the health endpoint:

```bash
curl https://proxy.yourdomain.com/api/health
```

Expected response:

```json
{
  "status": "ok",
  "environment": "production"
}
```

---

## Step 8: Continuous Deployment

With GitHub integration, deployments are automatic:

1. Make changes to your code locally
2. Commit and push:
   ```bash
   git add .
   git commit -m "Update configuration"
   git push origin main
   ```
3. Cloudflare automatically detects the push
4. Runs the deploy command: `npm ci && npm run deploy` (using your saved `D1_DATABASE_ID` / `KV_NAMESPACE_ID` build variables)
5. Deploys the new version

For terminal deploys, re-run `npm run deploy -- --d1 <id> --kv <id>` whenever you want to ship an update manually.

**View deployment history**:

- Go to your worker in the dashboard
- Click **Deployments** tab
- See all past deployments with timestamps and Git commit info

**Rollback if needed**:

- Click on a previous successful deployment
- Click **Rollback to this deployment**

---

## Troubleshooting

### Issue: TypeScript error about 'baseUrl' deprecated

**Error message**:

```
tsconfig.json:15:27 - error TS5101: Option 'baseUrl' is deprecated
```

**Cause**: Cloudflare didn't detect the `.node-version` file, or you're using an old deployment.

**Solution**: The repository includes a `.node-version` file that tells Cloudflare to use Node.js 22. If you still see this error:

1. Ensure the `.node-version` file exists in your repository root
2. Retry the deployment from the **Deployments** tab

### Issue: "No D1 database binding found for 'DB'"

**Cause**: D1 database not bound to the worker.

**Solution**:

1. If deploying with the wrapper, make sure you passed `--d1 <id>` (or set `D1_DATABASE_ID`)
2. Otherwise go to **Settings** → **Bindings** → **D1 Database Bindings**
3. Verify variable name is exactly `DB`
4. Verify the correct database is selected
5. Click **Save** and retry deployment

### Issue: "Missing real D1 database id" / "Missing real KV namespace id"

**Cause**: The deploy wrapper refuses to deploy with the placeholder IDs shipped in the public repo.

**Solution**:

- Terminal deploys: pass `--d1 <id> --kv <id>` (see Step 2)
- Git-integration deploys: set `D1_DATABASE_ID` and `KV_NAMESPACE_ID` under **Settings → Builds & deployments → Variables** (see Step 3.3)

### Issue: "Unknown provider: mock" or email errors

**Cause**: Email provider not configured.

**Solution**: Add environment variable `EMAIL_PROVIDER=console` in **Settings** → **Variables and Secrets**

### Issue: "Template not found" errors

**Cause**: Database migrations not applied.

**Solution**: Run migrations with the wrapper (`npm run migrate -- --d1 <id>`) or D1 Console (see Step 4)

### Issue: Build fails with "Cannot find module"

**Cause**: Build command may be incorrect or dependencies missing.

**Solution**:

1. Go to **Settings** → **Builds & deployments**
2. Verify **Deploy command** is: `npm ci && npm run deploy`
3. Retry deployment

### Issue: "Rate limit exceeded" or 429 errors

**Cause**: Default rate limiter shards may be too low.

**Solution**: Add environment variable `RATE_LIMITER_SHARDS=8` (or higher)

### Issue: Dashboard shows blank page

**Cause**: `BASE_URL` or `DASHBOARD_URL` mismatch.

**Solution**:

1. Go to **Settings** → **Variables and Secrets**
2. Update `BASE_URL` and `DASHBOARD_URL` to match your actual domain
3. Both should be the same value (e.g., `https://proxy.yourdomain.com`)

---

## Security Checklist

Before going live:

- [ ] Database migrations applied successfully
- [ ] All resource bindings configured (D1, KV, DOs)
- [ ] `D1_DATABASE_ID` / `KV_NAMESPACE_ID` provided via CLI flags or build variables (never committed)
- [ ] `BASE_URL` and `DASHBOARD_URL` set to your domain
- [ ] Email provider configured (or set to `console`)
- [ ] Changed default admin password
- [ ] Custom domain with HTTPS enabled
- [ ] Tested API health endpoint
- [ ] Tested creating API keys
- [ ] No secrets committed to Git
- [ ] Reviewed environment variables

---

## Next Steps

1. **Add LLM Provider Keys**: Configure OpenAI, Anthropic, Google, etc.
2. **Create API Keys**: Generate keys for your applications
3. **Set Up Monitoring**: Check metrics and logs in dashboard
4. **Configure Alerts**: Set spend limits and error rate alerts
5. **Invite Team Members**: Create additional admin/user accounts

For more information, see:

- [README.md](./README.md) - Project overview and features
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
