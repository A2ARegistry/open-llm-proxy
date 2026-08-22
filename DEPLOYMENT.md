# Deployment Guide: Open LLM Proxy on Cloudflare

This guide provides step-by-step instructions for deploying **Open LLM Proxy** to Cloudflare Workers using the **Cloudflare Dashboard web portal** with GitHub integration.

**Important**: This is an open-source project, so `wrangler.jsonc` contains only development/local settings. **Never commit production credentials, database IDs, or domains to Git.** All production configuration is done through the Cloudflare Dashboard.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Create Cloudflare Resources](#step-1-create-cloudflare-resources)
3. [Connect GitHub and Deploy](#step-2-connect-github-and-deploy)
4. [Apply Database Migrations](#step-3-apply-database-migrations)
5. [Configure Production Settings](#step-4-configure-production-settings)
6. [Configure Custom Domain](#step-5-configure-custom-domain-optional)
7. [Verify Deployment](#step-6-verify-deployment)
8. [Continuous Deployment](#step-7-continuous-deployment)

---

## Prerequisites

- Cloudflare account (free tier works)
- GitHub repository with this code (forked or your own)
- GitHub account connected to Cloudflare (one-time OAuth setup)

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

## Step 2: Connect GitHub and Deploy

### 2.1 Create Worker from Git

1. In Cloudflare Dashboard, go to **Workers & Pages**
2. Click **Create Application**
3. Click the **Workers** tab
4. Click **Connect to Git**

### 2.2 Connect GitHub Repository

1. If first time: Click **Connect GitHub** and authorize Cloudflare
2. Select your GitHub account
3. Find and select the `open-llm-proxy` repository (or your fork)
4. Click **Begin setup**

### 2.3 Configure Build Settings

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

**Note**: The `npm run deploy` script will:
1. Build TypeScript and dashboard (`npm run build`)
2. Apply database migrations (`npm run migrate`)
3. Deploy to Cloudflare Workers (`wrangler deploy`)

Click **Save and Deploy**

### 2.4 Initial Deployment (Will Fail - Expected)

The first deployment will fail because bindings (D1, KV) are not configured yet. This is expected. The worker needs to exist before we can configure its bindings.

You'll see an error like:
```
Error: No D1 database binding found for 'DB'
```

This is normal - proceed to the next step.

---

## Step 3: Apply Database Migrations

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

# Apply migrations (replace with your database name)
npx wrangler d1 migrations apply open-llm-proxy --remote
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

## Step 4: Configure Production Settings

Now configure the worker with the resources you created.

### 4.1 Access Worker Settings

1. Go to **Workers & Pages**
2. Click on your worker (e.g., `open-llm-proxy`)
3. Click **Settings** tab
4. Click **Variables and Secrets** in the left sidebar

### 4.2 Add Resource Bindings

#### D1 Database Binding

1. Scroll to **D1 Database Bindings**
2. Click **Add binding**
3. **Variable name**: `DB` (must be exactly this)
4. **D1 database**: Select your database (e.g., `open-llm-proxy`)
5. Click **Save**

#### KV Namespace Binding

1. Scroll to **KV Namespace Bindings**
2. Click **Add binding**
3. **Variable name**: `SESSION_CACHE` (must be exactly this)
4. **KV namespace**: Select your namespace (e.g., `open-llm-proxy-sessions`)
5. Click **Save**

#### Durable Object Bindings

Scroll to **Durable Object Bindings** and add each of these:

| Variable Name           | Durable Object Class Name | Script Name         |
| ----------------------- | ------------------------- | ------------------- |
| `RATE_LIMITER`          | `RateLimiter`             | (select your worker)|
| `RESPONSE_CACHE`        | `ResponseCache`           | (select your worker)|
| `SESSION_MANAGER`       | `SessionManager`          | (select your worker)|
| `METRICS_BUFFER`        | `MetricsBuffer`           | (select your worker)|
| `EMAIL_TEMPLATE_CACHE`  | `EmailingCacheDO`         | (select your worker)|

For each binding:
1. Click **Add binding**
2. Enter the **Variable name**
3. Select the **Durable Object class**
4. Select your worker from **Script name** dropdown
5. Click **Save**

### 4.3 Add Environment Variables

Scroll to **Environment Variables** section.

Click **Add variable** for each of these:

**Required Variables**:

| Variable               | Value (Example)                    | Description                         |
| ---------------------- | ---------------------------------- | ----------------------------------- |
| `ENVIRONMENT`          | `production`                       | Deployment environment              |
| `BASE_URL`             | `https://proxy.yourdomain.com`     | Your public API URL                 |
| `DASHBOARD_URL`        | `https://proxy.yourdomain.com`     | Admin dashboard URL (same as above) |

**Optional Variables** (recommended):

| Variable                    | Value (Example)      | Description                              |
| --------------------------- | -------------------- | ---------------------------------------- |
| `APP_NAME`                  | `Open LLM Proxy`     | App name in UI and emails                |
| `RATE_LIMITER_SHARDS`       | `8`                  | Number of rate limiter shards (default: 4)|
| `METRICS_BUFFER_SHARDS`     | `8`                  | Number of metrics buffer shards (default: 4)|
| `SESSION_CACHE_TTL_SECONDS` | `3600`               | Session cache TTL in seconds (default: 60)|
| `EMAIL_PROVIDER`            | `console`            | Email provider (see options below)       |
| `EMAIL_FROM_NAME`           | `Open LLM Proxy`     | Email sender name                        |
| `EMAIL_FROM_ADDRESS`        | `noreply@yourdomain.com` | Email sender address                |

**Email Provider Options**:
- `console` - Logs emails to console (recommended for testing)
- `mailchannels` - Uses Cloudflare MailChannels (free)
- `resend` - Requires `RESEND_API_KEY` secret
- `sendgrid` - Requires `SENDGRID_API_KEY` secret
- `sendpulse` - Requires `SENDPULSE_CLIENT_ID` and `SENDPULSE_CLIENT_SECRET` secrets

**Important**: Click **Save** after adding all variables.

### 4.4 Add Secrets (If Using Email)

If you set `EMAIL_PROVIDER` to `resend`, `sendgrid`, or `sendpulse`:

1. Scroll to **Environment Variables** section
2. Click **Add variable**
3. Enter the **Variable name** (e.g., `RESEND_API_KEY`)
4. Enter the **Value** (your API key)
5. Select **Encrypt** checkbox
6. Click **Save**

Common secrets:

| Secret Name               | When Required              |
| ------------------------- | -------------------------- |
| `RESEND_API_KEY`          | EMAIL_PROVIDER=resend      |
| `SENDGRID_API_KEY`        | EMAIL_PROVIDER=sendgrid    |
| `SENDPULSE_CLIENT_ID`     | EMAIL_PROVIDER=sendpulse   |
| `SENDPULSE_CLIENT_SECRET` | EMAIL_PROVIDER=sendpulse   |

---

## Step 5: Configure Custom Domain (Optional)

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

## Step 6: Verify Deployment

### 6.1 Trigger a New Deployment

After configuring all bindings and variables:

1. Go to **Deployments** tab
2. Click **Retry deployment** on the failed deployment

OR

1. Make a small commit to your GitHub repository
2. Push to the `main` branch
3. Cloudflare will automatically build and deploy

### 6.2 Check Deployment Status

1. Go to **Deployments** tab
2. Wait for the deployment to complete (green checkmark)
3. You should see "Deployment successful"

### 6.3 Access the Dashboard

Visit your deployment URL:
```
https://proxy.yourdomain.com
# or
https://open-llm-proxy.YOUR-SUBDOMAIN.workers.dev
```

You should see the Open LLM Proxy admin dashboard login page.

### 6.4 Complete Initial Setup

1. On first visit, you'll see the bootstrap/setup page
2. Note the default admin credentials (shown only once)
3. Log in with the default credentials
4. **Immediately change the admin password** in settings

### 6.5 Test the API

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

## Step 7: Continuous Deployment

With GitHub integration, deployments are automatic:

1. Make changes to your code locally
2. Commit and push:
   ```bash
   git add .
   git commit -m "Update configuration"
   git push origin main
   ```
3. Cloudflare automatically detects the push
4. Runs the deploy command: `npm ci && npm run deploy`
5. Deploys the new version

**View deployment history**:
- Go to your worker in the dashboard
- Click **Deployments** tab
- See all past deployments with timestamps and Git commit info

**Rollback if needed**:
- Click on a previous successful deployment
- Click **Rollback to this deployment**

---

## Troubleshooting

### Issue: "No D1 database binding found for 'DB'"

**Cause**: D1 database not bound to the worker.

**Solution**:
1. Go to **Settings** → **Variables and Secrets** → **D1 Database Bindings**
2. Verify variable name is exactly `DB`
3. Verify the correct database is selected
4. Click **Save** and retry deployment

### Issue: "Unknown provider: mock" or email errors

**Cause**: Email provider not configured.

**Solution**: Add environment variable `EMAIL_PROVIDER=console` in **Settings** → **Variables and Secrets**

### Issue: "Template not found" errors

**Cause**: Database migrations not applied.

**Solution**: Run migrations using Wrangler CLI or D1 Console (see Step 3)

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

