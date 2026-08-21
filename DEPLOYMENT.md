# Deployment Guide for Cloudflare Workers

This guide walks you through deploying the Open LLM Proxy to Cloudflare Workers with a custom domain.

## Prerequisites

1. **Cloudflare Account** with Workers paid plan (required for Durable Objects, D1, and custom domains)
2. **Domain** managed by Cloudflare (e.g., `api.zervice.us`)
3. **Node.js** and **npm** installed
4. **Wrangler CLI** (included in project dependencies)

## Step 1: Build the Dashboard

Before deploying, build the React dashboard:

```bash
npm run build:dashboard
```

This creates optimized static assets in `dashboard/dist/` that will be served by the Worker.

## Step 2: Login to Cloudflare

```bash
npm run cf:login
```

Follow the browser prompts to authenticate.

## Step 3: Create Cloudflare Resources

### 3.1 Create Production D1 Database

```bash
# Create the production database
wrangler d1 create open-llm-proxy-prod

# Copy the database_id from output
```

Update `wrangler.jsonc` **in the `env.production` section**:
```jsonc
"env": {
  "production": {
    // ...
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "open-llm-proxy-prod",
        "database_id": "YOUR_ACTUAL_PROD_DATABASE_ID_HERE"
      }
    ]
  }
}
```

**Note:** Your local dev environment uses `--local` flag and won't be affected.

### 3.2 Create Production KV Namespace

```bash
# Create production KV namespace for session cache
wrangler kv:namespace create SESSION_CACHE --env production

# Copy the id from output
```

Update `wrangler.jsonc` **in the `env.production` section**:
```jsonc
"env": {
  "production": {
    // ...
    "kv_namespaces": [
      {
        "binding": "SESSION_CACHE",
        "id": "YOUR_ACTUAL_PROD_KV_NAMESPACE_ID_HERE"
      }
    ]
  }
}
```

## Step 4: Configure Environment Variables

Production environment variables are already configured in `wrangler.jsonc` under the `env.production` section. You just need to update the URLs to match your domain:

```jsonc
"env": {
  "production": {
    "vars": {
      "BASE_URL": "https://api.zervice.us",
      "ENVIRONMENT": "production",
      "DASHBOARD_URL": "https://api.zervice.us",
      "SESSION_CACHE_TTL_SECONDS": "3600",
      "RATE_LIMITER_SHARDS": "8",
      "METRICS_BUFFER_SHARDS": "8",
      "APP_NAME": "Open LLM Proxy"
    }
  }
}
```

**Note:** The top-level `vars` are for local development and remain unchanged:
```jsonc
"vars": {
  "BASE_URL": "http://localhost:8787",
  "ENVIRONMENT": "development",
  // ... keep these for local dev
}
```

This separation ensures your local development environment (`npm run dev`) continues to work without modifications.

### Optional: Email Configuration (Secrets)

If you want email functionality, set these as **secrets** (not in wrangler.jsonc):

```bash
wrangler secret put EMAIL_FROM_NAME
# Enter: Your App Name

wrangler secret put EMAIL_FROM_ADDRESS
# Enter: noreply@zervice.us

wrangler secret put SENDPULSE_CLIENT_ID
# Enter: your-sendpulse-client-id

wrangler secret put SENDPULSE_CLIENT_SECRET
# Enter: your-sendpulse-client-secret
```

## Step 5: Run Database Migrations

Apply all schema migrations to your production D1 database:

```bash
npm run migrate
```

This runs migrations with `--env production --remote` flags, targeting only your production database.

**Your local development database is separate** and uses `--local` flag with `npm run dev`.

## Step 6: Deploy the Worker

```bash
npm run deploy
```

This deploys your Worker to Cloudflare's production environment with `--env production` flag. You'll see output like:

```
Total Upload: 1.2 MiB / gzip: 300 KiB
Uploaded open-llm-proxy (2.3 sec)
Published open-llm-proxy (production) (0.5 sec)
  https://open-llm-proxy.<your-subdomain>.workers.dev
```

**Note:** Local development (`npm run dev`) continues to use localhost settings and local D1/KV storage.

## Step 7: Configure Custom Domain

### 7.1 Add Custom Domain in Cloudflare Dashboard

1. Go to **Cloudflare Dashboard** → **Workers & Pages**
2. Click your `open-llm-proxy` worker
3. Go to **Settings** → **Domains & Routes**
4. Click **Add Custom Domain**
5. Enter: `api.zervice.us`
6. Click **Add Custom Domain**

Cloudflare automatically:
- Creates DNS records
- Provisions SSL certificate
- Routes traffic to your Worker

### 7.2 Alternative: Using Wrangler CLI

```bash
wrangler domains add api.zervice.us
```

## Step 8: Verify Deployment

### Test the API endpoint:

```bash
curl https://api.zervice.us/api/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-08-21T12:00:00.000Z"
}
```

### Access the Dashboard:

Open in browser: `https://api.zervice.us`

You should see the React dashboard login page.

## Step 9: Create Your First Organization

Use the onboarding API to create your first organization:

```bash
curl -X POST https://api.zervice.us/api/onboarding \
  -H "Content-Type: application/json" \
  -d '{
    "organizationName": "My Organization",
    "organizationSlug": "my-org",
    "userName": "Admin User",
    "userEmail": "admin@zervice.us"
  }'
```

Save the returned API key and organization details.

## Ongoing Maintenance

### Update Deployment

When you make code changes:

```bash
# 1. Rebuild dashboard if frontend changed
npm run build:dashboard

# 2. Deploy
npm run deploy
```

### Run New Migrations

If you add new migrations:

```bash
npm run migrate
```

### View Logs

```bash
wrangler tail
```

### Rollback (if needed)

```bash
wrangler rollback
```

## Architecture Overview

Your deployment includes:

- **Worker**: Hono-based HTTP handler for API and dashboard serving
- **D1 Database**: Relational data (organizations, API keys, providers, settings)
- **KV Namespace**: Session caching
- **Durable Objects**: 
  - `EmailingCacheDO`: Email template caching
  - `MetricsBuffer`: Request metrics aggregation
  - `RateLimiter`: Per-key rate limiting
  - `ResponseCache`: LLM response caching
  - `SessionManager`: Session state
- **Assets**: React dashboard SPA
- **Cron Trigger**: Runs every 5 minutes for alerts/cleanup

## Custom Domain Benefits

1. **Professional URL**: `https://api.zervice.us` instead of `*.workers.dev`
2. **SSL/TLS**: Automatic HTTPS with Cloudflare certificate
3. **Global CDN**: Low-latency access worldwide
4. **Endpoint Display**: API keys show proper base URL in dashboard

## Troubleshooting

### "Database not found"
Run migrations: `npm run migrate`

### "KV namespace not found"
Verify KV namespace ID in `wrangler.jsonc` matches created namespace

### Dashboard shows 404
Ensure `npm run build:dashboard` was run before `npm run deploy`

### Worker fails to deploy
Check syntax: `npm run tsc` (should show no errors)

### Domain not resolving
- DNS propagation can take 5-10 minutes
- Verify domain is on Cloudflare nameservers
- Check Workers dashboard → Domains & Routes

## Production Checklist

- [ ] Dashboard built (`npm run build:dashboard`)
- [ ] D1 database created and ID updated in `wrangler.jsonc`
- [ ] KV namespace created and ID updated in `wrangler.jsonc`
- [ ] Production `vars` configured in `wrangler.jsonc`
- [ ] Secrets set via `wrangler secret put` (if using email)
- [ ] Migrations applied (`npm run migrate`)
- [ ] Worker deployed (`npm run deploy`)
- [ ] Custom domain configured (`api.zervice.us`)
- [ ] Health check passes
- [ ] Dashboard accessible
- [ ] First organization created

## Support

For issues or questions:
1. Check Cloudflare Workers logs: `wrangler tail`
2. Review Cloudflare Dashboard → Workers & Pages → open-llm-proxy → Logs
3. Verify D1 database has tables: `wrangler d1 execute DB --command "SELECT name FROM sqlite_master WHERE type='table'"`
