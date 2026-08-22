# Deployment Guide: Open LLM Proxy on Cloudflare

This guide provides step-by-step instructions for deploying **Open LLM Proxy** to Cloudflare Workers in production using the Cloudflare Dashboard.

**Important**: This is an open-source project, so `wrangler.jsonc` contains only development/local settings. **Never commit production credentials, database IDs, or domains to Git.** All production configuration is done through the Cloudflare Dashboard.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Create Cloudflare Resources](#step-1-create-cloudflare-resources)
3. [Apply Database Migrations](#step-2-apply-database-migrations)
4. [Deploy via Cloudflare Dashboard](#step-3-deploy-via-cloudflare-dashboard)
5. [Configure Production Settings](#step-4-configure-production-settings)
6. [Configure Custom Domain](#step-5-configure-custom-domain-optional)
7. [Verify Deployment](#step-6-verify-deployment)
8. [Continuous Deployment](#step-7-continuous-deployment)

---

## Prerequisites

- Cloudflare account (free tier works)
- GitHub repository with this code
- Wrangler CLI installed: `npm install -g wrangler`
- Logged in to Wrangler: `npx wrangler login`

---

## Step 1: Create Cloudflare Resources

All resources must be created in your Cloudflare account before deployment.

### 1.1 Create D1 Database

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **D1 SQL Databases**
3. Click **Create Database**
4. Name: `open-llm-proxy` (or any name you prefer)
5. Click **Create**
6. **Copy the Database ID** (looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)

### 1.2 Create KV Namespace

1. In Cloudflare Dashboard, go to **Workers & Pages** → **KV**
2. Click **Create Namespace**
3. Name: `open-llm-proxy-sessions` (or any name you prefer)
4. Click **Add**
5. **Copy the Namespace ID** (looks like `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`)

### 1.3 Create Durable Objects (Automatic)

Durable Objects will be automatically created when you deploy. No manual setup needed for:
- `RateLimiter`
- `ResponseCache`
- `SessionManager`
- `MetricsBuffer`
- `EmailingCacheDO`

---

## Step 2: Apply Database Migrations

Before deploying, apply the D1 migrations to create the database schema.

### Option A: Using Wrangler CLI (Recommended)

```bash
# Set your database name or ID
export DB_NAME="open-llm-proxy"  # or use the Database ID

# Apply migrations to production
npx wrangler d1 migrations apply $DB_NAME --remote
```

You should see output like:
```
Migrations to be applied:
┌──────────────────┐
│ 0001_auth.sql    │
│ 0002_email.sql   │
│ 0003_app.sql     │
└──────────────────┘
✔ About to apply 3 migration(s)
Your database may not be available to serve requests during the migration, continue? … yes
🌀 Mapping SQL input into an array of statements
🌀 Executing on remote database open-llm-proxy (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx):
✅ Successfully applied 3 migration(s)!
```

### Option B: Using D1 Console in Dashboard

1. Go to your D1 database in the Cloudflare Dashboard
2. Click **Console** tab
3. Copy and paste the contents of each migration file in order:
   - `migrations/0001_auth.sql`
   - `migrations/0002_email.sql`
   - `migrations/0003_app.sql`
4. Execute each one

---

## Step 3: Deploy via Cloudflare Dashboard

You can deploy using either Git Integration (automatic) or Manual Upload.

### Option A: Git Integration (Recommended for CI/CD)

1. Go to **Workers & Pages** → **Create Application**
2. Click **Workers** tab
3. Click **Connect to Git**
4. Select your GitHub account and repository
5. Choose the branch to deploy (e.g., `main`)
6. Configure build settings:
   - **Build command**: `npm ci && npm run build`
   - **Build output directory**: Leave empty (Worker deployment)
7. Click **Save and Deploy**

### Option B: Manual Deployment via CLI

```bash
# Build the project
npm run build

# Deploy to production
npx wrangler deploy --env production

# Or use the deploy script (includes migrations)
npm run deploy
```

---

## Step 4: Configure Production Settings

After deployment, configure the Worker in the Cloudflare Dashboard.

### 4.1 Bind Resources

Go to your Worker → **Settings** → **Variables and Secrets**

#### Add Bindings:

1. **D1 Database**:
   - Click **Add** under **D1 Database Bindings**
   - Variable name: `DB`
   - D1 Database: Select your database (e.g., `open-llm-proxy`)
   - Click **Save**

2. **KV Namespace**:
   - Click **Add** under **KV Namespace Bindings**
   - Variable name: `SESSION_CACHE`
   - KV Namespace: Select your namespace (e.g., `open-llm-proxy-sessions`)
   - Click **Save**

3. **Durable Object Bindings** (if not auto-bound):
   - Variable: `RATE_LIMITER` → Class: `RateLimiter`
   - Variable: `RESPONSE_CACHE` → Class: `ResponseCache`
   - Variable: `SESSION_MANAGER` → Class: `SessionManager`
   - Variable: `METRICS_BUFFER` → Class: `MetricsBuffer`
   - Variable: `EMAIL_TEMPLATE_CACHE` → Class: `EmailingCacheDO`

### 4.2 Environment Variables

Click **Add Variable** to add these production environment variables:

| Variable                    | Value (Example)                      | Required | Description                              |
| --------------------------- | ------------------------------------ | -------- | ---------------------------------------- |
| `ENVIRONMENT`               | `production`                         | Yes      | Deployment environment                   |
| `BASE_URL`                  | `https://proxy.yourdomain.com`       | Yes      | Public base URL for the API              |
| `DASHBOARD_URL`             | `https://proxy.yourdomain.com`       | Yes      | URL where admin dashboard is hosted      |
| `APP_NAME`                  | `Open LLM Proxy`                     | No       | App name in UI and emails                |
| `RATE_LIMITER_SHARDS`       | `8`                                  | No       | Number of rate limiter DO shards         |
| `METRICS_BUFFER_SHARDS`     | `8`                                  | No       | Number of metrics buffer DO shards       |
| `SESSION_CACHE_TTL_SECONDS` | `3600`                               | No       | Session cache TTL (1 hour)               |
| `EMAIL_PROVIDER`            | `mailchannels`                       | No       | Email provider (console/mailchannels/resend/sendgrid/sendpulse) |
| `EMAIL_FROM_NAME`           | `Open LLM Proxy`                     | No       | Email sender name                        |
| `EMAIL_FROM_ADDRESS`        | `noreply@yourdomain.com`             | No       | Email sender address                     |

**Note**: Use `console` for `EMAIL_PROVIDER` during testing to log emails instead of sending them.

### 4.3 Secrets (Encrypted Variables)

Click **Add Secret** to add encrypted credentials:

| Secret                    | Description                                   | When Required              |
| ------------------------- | --------------------------------------------- | -------------------------- |
| `RESEND_API_KEY`          | Resend email API key                          | If EMAIL_PROVIDER=resend   |
| `SENDGRID_API_KEY`        | SendGrid email API key                        | If EMAIL_PROVIDER=sendgrid |
| `SENDPULSE_CLIENT_ID`     | SendPulse OAuth client ID                     | If EMAIL_PROVIDER=sendpulse|
| `SENDPULSE_CLIENT_SECRET` | SendPulse OAuth client secret                 | If EMAIL_PROVIDER=sendpulse|
| `TURNSTILE_SECRET`        | Cloudflare Turnstile secret (for bot protection) | If using Turnstile      |

**Important**: Click **Save** after adding all variables and secrets.

---

## Step 5: Configure Custom Domain (Optional)

To use your own domain instead of `*.workers.dev`:

1. Go to your Worker → **Settings** → **Domains & Routes**
2. Click **Add** → **Custom Domain**
3. Enter your domain: `proxy.yourdomain.com`
4. Cloudflare will:
   - Add DNS records automatically
   - Provision SSL/TLS certificates
   - Enable HTTPS automatically

**Note**: Your domain must be managed by Cloudflare DNS for this to work automatically.

---

## Step 6: Verify Deployment

### 6.1 Check Dashboard

Visit your deployment URL:
```
https://proxy.yourdomain.com
# or
https://open-llm-proxy.your-subdomain.workers.dev
```

You should see the admin dashboard login page.

### 6.2 Check Health Endpoint

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

### 6.3 Complete Initial Setup

1. Visit the dashboard URL
2. You'll see the bootstrap page with default admin credentials
3. Log in and **change the default password immediately**
4. The default admin credentials will only show on first visit

### 6.4 Verify Database

Check that templates were seeded:

```bash
# View database tables
npx wrangler d1 execute open-llm-proxy --remote --command "SELECT COUNT(*) FROM system_email_templates"
```

Should return `6` (or the number of templates in `src/email/templates.ts`).

---

## Step 7: Continuous Deployment

### Automatic Deployment (Git Integration)

If you set up Git integration in Step 3:

1. Make changes to your code
2. Commit and push to GitHub:
   ```bash
   git add .
   git commit -m "Update configuration"
   git push origin main
   ```
3. Cloudflare automatically rebuilds and deploys
4. Check deployment status in **Workers & Pages** → **Deployments**

### Manual Deployment

```bash
# Build and deploy
npm run deploy

# This runs:
# 1. npm run build (TypeScript check + dashboard build)
# 2. npm run migrate (apply new DB migrations)
# 3. wrangler deploy --env production
```

---

## Troubleshooting

### Issue: "Unknown provider: mock"

**Solution**: Set `EMAIL_PROVIDER=console` or `EMAIL_PROVIDER=mailchannels` in environment variables.

### Issue: "Template not found"

**Solution**: Run migrations again:
```bash
npx wrangler d1 migrations apply open-llm-proxy --remote
```

### Issue: "Database binding not found"

**Solution**: Verify the D1 binding in **Settings** → **Variables and Secrets** → **D1 Database Bindings**. The variable name must be exactly `DB`.

### Issue: "Module not found" or "Cannot find module"

**Solution**: Run `npm run build` before deploying. The dashboard build must complete successfully.

### Issue: Rate limits or CORS errors

**Solution**: Check that `BASE_URL` and `DASHBOARD_URL` match your actual domain/URL.

---

## Security Checklist

Before going live:

- [ ] Changed default admin password
- [ ] Set strong `BASE_URL` and `DASHBOARD_URL` values
- [ ] Email provider configured (or set to `console` for testing)
- [ ] Custom domain with HTTPS enabled
- [ ] D1 database migrations applied
- [ ] Reviewed rate limits in dashboard
- [ ] No secrets committed to Git
- [ ] Tested API key creation and LLM requests

---

## Next Steps

1. **Configure Provider API Keys**: Add OpenAI, Anthropic, or other LLM provider keys
2. **Set Up Alerting**: Configure spend limits and error rate alerts
3. **Monitor Usage**: Check the metrics dashboard
4. **Invite Team Members**: Create additional admin/user accounts

For more information, see:
- [README.md](./README.md) - Getting started guide
- [QUICK-DEPLOY.md](./QUICK-DEPLOY.md) - Quick deployment reference
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
