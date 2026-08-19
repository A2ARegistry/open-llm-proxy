# V2 Architecture: Multi-Tenant LLM Gateway with Pi-AI

## Document Information

- **Version**: 2.0.0
- **Status**: Design Phase
- **Created**: 2026-08-17
- **Target Platform**: Cloudflare Workers + D1 + Durable Objects

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Overview](#system-overview)
3. [Architecture Principles](#architecture-principles)
4. [Core Components](#core-components)
5. [Feature List](#feature-list)
6. [Database Schema](#database-schema)
7. [API Specification](#api-specification)
8. [Implementation Roadmap](#implementation-roadmap)
9. [Migration Strategy](#migration-strategy)
10. [Monitoring & Observability](#monitoring--observability)

---

## Executive Summary

This document outlines the V2 architecture for transforming the current Open LLM Proxy into a **production-ready, multi-tenant SaaS gateway** with:

- **Pi-AI Integration**: Adopt `@earendil-works/pi-ai` as the primary provider layer, retaining the existing V1 providers as a native-fetch fallback
- **Multi-Tenancy**: Support multiple organizations with isolated configurations
- **User Authentication**: Login system with role-based access control
- **Backend Configuration UI**: Web dashboard for managing providers, keys, and settings
- **Performance Metrics**: Request tracking, latency monitoring, cost analytics
- **Scalable Storage**: D1 for config/metrics, Durable Objects for caching/rate limiting

**Target Deployment**: Cloudflare Workers (edge compute) + D1 (SQL) + Durable Objects (stateful)

---

## System Overview

### Current State (V1, retired)

- Single-tenant proxy with static configuration
- Manual provider implementations using native fetch
- Environment variable-based authentication (PROXY_API_KEY)
- No user management or multi-tenancy
- Basic key rotation via Durable Objects
- Limited metrics/observability

> The V1 env/config deployment path has been removed. Deploy is self-serve: the
> worker seeds a default admin (`admin@example.com` / `AwesomeProxy!!`), rotates
> its runtime secrets into D1 on first boot, and all provider/API-key config
> happens through the dashboard (D1-backed).

### Target State (V2)

```
┌─────────────────────────────────────────────────────────────┐
│                      Cloudflare Edge                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │            Cloudflare Workers (Router)                │  │
│  │  • Authentication & Authorization                     │  │
│  │  • Tenant Isolation                                   │  │
│  │  • Request Routing                                    │  │
│  └──────────┬───────────────────────────┬─────────────────┘  │
│             │                           │                    │
│  ┌──────────▼──────────┐    ┌──────────▼─────────────────┐ │
│  │   Admin Dashboard   │    │     Open LLM Proxy API     │ │
│  │   (Workers Pages)   │    │   (Pi-AI Integration)      │ │
│  └─────────────────────┘    └──────────┬─────────────────┘ │
│                                         │                    │
│  ┌──────────────────────────────────────▼─────────────────┐ │
│  │              Durable Objects Layer                      │ │
│  │  • Rate Limiting (hash-sharded per tenant/key)         │  │
│  │  • Metrics Buffering (durable, batch-flush to D1)      │  │
│  │  • Response Caching (LOW priority)                     │  │
│  └──────────────────────────────────────┬─────────────────┘ │
└─────────────────────────────────────────┼───────────────────┘
                                          │
                              ┌───────────▼──────────────┐
                              │   Cloudflare D1          │
                              │   • Tenants              │
                              │   • Users & Auth         │
                              │   • Provider Configs     │
                              │   • Request Metrics      │
                              │   • Usage Analytics      │
                              └──────────────────────────┘
```

---

## Architecture Principles

1. **Multi-Tenancy First**: Every resource is tenant-scoped
2. **Zero-Trust Security**: Authenticate and authorize every request
3. **Edge-Native**: Leverage Cloudflare's global network for low latency
4. **Observable by Default**: Track every request, error, and metric
5. **Cost-Aware**: Monitor and limit LLM API costs per tenant
6. **Backward Compatible**: Maintain OpenAI-compatible endpoints
7. **Fail Safely**: Graceful degradation, never expose credentials

---

## Core Components

### 1. Authentication & Authorization Layer

**Component**: `src/auth/`

**Responsibilities**:

- User authentication (session-based)
- Tenant identification and isolation
- Role-based access control (RBAC)
- API key validation (for programmatic access)

**Technologies**:

- Session cookies (httpOnly, secure, sameSite)
- Cloudflare D1 for session storage (source of truth) + KV read-through cache
- PBKDF2-SHA256 password hashing (via Workers WebCrypto)

### 2. Pi-AI Integration Layer

**Component**: `src/llm/`

**Responsibilities**:

- Unified LLM provider interface via pi-ai
- Credential management per tenant (never share a pi-ai `Models` collection across tenants — it holds credentials; create one collection per tenant/request)
- Request/response transformation
- Error handling and retry logic

**Technologies**:

- `@earendil-works/pi-ai` core library
- Selective per-provider subpath imports (OAuth + complex providers only, to keep the bundle small)
- **Native-fetch fallback**: retain the existing V1 provider layer (`src/providers/provider.ts`) for providers pi-ai does not cover first-class — Ollama, HuggingFace, Replicate, Cohere, Perplexity, and custom OpenAI-compatible endpoints

### 3. Tenant Management

**Component**: `src/tenants/`

**Responsibilities**:

- Tenant CRUD operations
- Provider configuration per tenant
- API key storage (encrypted)
- Quota and limit enforcement

**Storage**: Cloudflare D1

### 4. Metrics & Monitoring

**Component**: `src/metrics/`

**Responsibilities**:

- Request logging (latency, tokens, cost)
- Error tracking
- Usage analytics
- Cost tracking per tenant/user
- Exportable to external monitoring systems

**Storage**:

- D1 for persistent metrics
- Durable Objects for real-time aggregation
- Abstract interface for 3rd-party integrations (Prometheus, Datadog, etc.)

### 5. Caching & Rate Limiting

**Component**: `src/cache/` (Durable Objects)

**Responsibilities**:

- Semantic response caching (hot cache)
- Rate limiting per tenant/user/API key
- Session affinity (OpenAI Codex WebSocket reuse)
- Key rotation state (global round-robin)

**Storage**: Durable Objects (in-memory + storage API)

### 6. Admin Dashboard

**Component**: `dashboard/` (Cloudflare Pages)

**Responsibilities**:

- User login/logout
- Provider configuration UI
- API key management
- Usage analytics visualization
- Team member management
- Billing/quota overview

**Technologies**:

- React/Vue/Svelte (TBD)
- TanStack Query for API calls
- Chart.js/Recharts for analytics
- Tailwind CSS for styling

---

## Feature List

### Phase 1: Foundation (Weeks 1-2)

#### 1.1 Multi-Tenant Infrastructure ✓ Priority: HIGH

**Features**:

- [ ] D1 database schema for tenants, users, sessions
- [ ] Tenant isolation middleware
- [ ] Tenant CRUD API endpoints
- [ ] Encrypted credential storage in D1
- [ ] Tenant isolation test suite (unit + integration) as an explicit deliverable

**Acceptance Criteria**:

- Every request is tenant-scoped
- Tenants cannot access other tenants' data
- Credentials encrypted at rest (AES-256-GCM)
- Tenant isolation test suite passes:
  - User A cannot access Tenant B's data
  - API key from Tenant A cannot make requests for Tenant B
  - Metrics queries are properly scoped
  - Provider configs are isolated

**Files to Create/Modify**:

- `src/db/schema.sql`
- `src/tenants/tenant-service.ts`
- `src/tenants/crypto.ts`
- `src/middlewares/tenant.ts`

#### 1.2 Authentication System ✓ Priority: HIGH

**Features**:

- [ ] User registration with email + password (email verification required)
- [ ] Login endpoint with session management
- [ ] Password hashing (PBKDF2-SHA256 via WebCrypto)
- [ ] Session cookies (httpOnly, secure, sameSite=strict)
- [ ] Logout and session invalidation
- [ ] Role-based access control (Owner, Admin, Member, Viewer)

**Acceptance Criteria**:

- Users can register and login
- Sessions expire after 7 days of inactivity
- Passwords hashed with PBKDF2-SHA256 (100k+ iterations, salted per-user)
- Session lookups served from KV cache with D1 as source of truth
- RBAC prevents unauthorized actions

**API Endpoints**:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

**Email Verification**:

- [ ] Send verification email on registration
- [ ] Verification token with 24-hour expiry
- [ ] Account remains inactive until verified
- [ ] Resend verification option

**Files to Create**:

- `src/auth/auth-service.ts`
- `src/auth/password.ts`
- `src/auth/session.ts`
- `src/middlewares/auth-required.ts`

#### 1.3 Pi-AI Core Integration ✓ Priority: HIGH

**Features**:

- [ ] Install `@earendil-works/pi-ai` package
- [ ] Create tenant-scoped Models collections
- [ ] Implement credential store backed by D1
- [ ] Provider factory registry (Anthropic, OpenAI, Google, etc.)
- [ ] Reuse V1 provider layer as native-fetch fallback for providers pi-ai does not cover first-class (Ollama, HuggingFace, Replicate, Cohere, Perplexity, custom OpenAI-compatible endpoints)

**Acceptance Criteria**:

- Pi-AI successfully routes requests to providers
- Tenant credentials isolated in D1
- Bundle size under 2 MB (selective provider imports; enforced by a CI bundle-size gate)
- OAuth providers (Anthropic Claude Pro) functional (validate pi-ai OAuth on the Workers runtime early — pi-ai login flows are Node-only)

**CI Bundle Size Gate**:

- [ ] Fail if bundle > 2 MB (compressed)
- [ ] Warn if bundle > 1.5 MB
- [ ] Run on every PR
- [ ] Script: `scripts/check-bundle-size.ts` (via `wrangler deploy --dry-run`)

### Phase 2: Configuration & UI (Weeks 3-4)

#### 2.1 Provider Configuration API ✓ Priority: HIGH

**Features**:

- [ ] CRUD endpoints for provider configs per tenant
- [ ] API key management (add, update, delete, rotate)
- [ ] Provider enable/disable toggle
- [ ] Default model selection per tenant
- [ ] Per-tenant model allowlist (which models a tenant may call)
- [ ] Key rotation strategy configuration

**API Endpoints**:

- `GET /api/tenants/:id/providers`
- `POST /api/tenants/:id/providers/:provider/config`
- `PUT /api/tenants/:id/providers/:provider/config`
- `DELETE /api/tenants/:id/providers/:provider/config`
- `POST /api/tenants/:id/providers/:provider/keys`

**API Key Scoping** (Priority: MEDIUM):

- [x] Restrict API key to specific providers (`scopes.providers`)
- [x] Restrict API key to specific models (`scopes.models`)
- [x] Per-key spend caps (`scopes.spendCapUsd`, enforced by spend-guard)
- [x] IP allowlist per key (`scopes.ipAllowlist`)

**Files to Create**:

- `src/api/provider-config.ts`
- `src/tenants/provider-service.ts`

#### 2.2 Admin Dashboard (Frontend) ✓ Priority: HIGH

**Features** (implemented):

- [x] Login/Register UI (content-auth `AuthForm`, signin/signup/forgot/reset/verify/accept-invite)
- [x] Dashboard home with usage overview (30d cost line chart + spend alerts)
- [x] Provider configuration page
  - List configured providers, add from catalog
  - Configure API keys (encrypted at rest), default model
  - Enable/disable/remove providers
- [x] API key management page
  - Generate tenant API keys (shown once), rotate, revoke, optional spend cap
- [x] Team management page
  - Invite users (email + role), cancel invitations, change roles, remove, transfer ownership
- [x] Analytics page
  - Request volume/cost/error summary, latency p50/p95/p99, recent request table
- [x] Email page (templates, tenant settings, delivery logs) and Settings page (spend limits)

**Technologies**:

- React + TypeScript
- React Router (routing)
- TanStack Query (API state management)
- Recharts (analytics charts)
- Tailwind CSS (v4)

**Files to Create**: `dashboard/` (Vite app) — served via the Worker `ASSETS` binding with SPA fallback.

**API surface (session-authenticated, owner/admin for mutations)**:

- `GET/PUT/DELETE /api/providers*`, `GET/POST/PATCH/DELETE/rotate /api/keys*`
- `GET /api/usage/costs`, `PUT /api/usage/limits`, `GET /api/usage/alerts`
- `GET /api/metrics/summary|latency|requests`
- `GET/POST/DELETE /api/email/templates*`, `GET/POST /api/email/settings`, `GET /api/email/logs|stats`

#### 2.3 User & Team Management ✓ Priority: MEDIUM

**Features** (implemented):

- [x] Invite users to tenant (email + role; invitation email via `invite` template)
- [x] Role assignment (Owner, Admin, Member, Viewer)
- [x] User list with role display
- [x] Remove user from tenant (owner guards enforced)
- [x] Transfer ownership (owner-only, atomic role swap)

**API Endpoints** (implemented):

- `GET /api/team/members` — members joined with user details
- `GET /api/team/invitations` — pending invitations
- `POST /api/team/invitations` — invite by email/role (owner/admin)
- `POST /api/team/invitations/:id/cancel`
- `PATCH /api/team/members/:id/role`
- `DELETE /api/team/members/:id`
- `POST /api/team/transfer-ownership`

**Files to Create**: `src/api/team.ts` (+ `test/src/api/team.test.ts`), active-org fallback in `src/middlewares/auth-required.ts` (`organizations.updatedAt` lives in `migrations/0001_auth.sql`).

### Phase 3: Metrics & Monitoring (Weeks 5-6)

#### 3.1 Request Metrics Collection ✓ Priority: HIGH

**Features**:

- [ ] Log every LLM request with:
  - Timestamp
  - Tenant ID
  - User ID
  - Provider
  - Model
  - Tokens (input/output)
  - Latency (ms)
  - Cost (USD)
  - HTTP status
  - Error message (if failed)
- [ ] Buffer metrics in a Durable Object and batch-write to D1 (in-memory worker buffers are lost on isolate eviction)
- [ ] Query API for analytics

**Acceptance Criteria**:

- < 5ms overhead for metrics collection
- Metrics survive worker restarts/evictions (buffered in a Durable Object with durable storage, flushed to D1 in batches)
- Queryable by tenant, date range, provider, model

**Files to Create**:

- `src/metrics/request-logger.ts`
- `src/metrics/metrics-service.ts`
- `src/api/metrics.ts`

#### 3.2 Performance Monitoring ✓ Priority: MEDIUM

**Features**:

- [x] Track p50, p95, p99 latencies per provider — `GET /api/metrics/latency` (dashboard Analytics)
- [x] Error rate monitoring — `request_metrics.status_code` rollups, `GET /api/metrics/summary`
- [x] Success rate by provider — included in `GET /api/metrics/summary`
- [x] Alert on high error rates (>5%) — cron evaluator (`src/alerts/evaluator.ts`) + `high_error_rate` template
- [ ] Export metrics to external systems (Prometheus/Webhook exporters) — D1 export via `request_metrics` is in place; pull/push exporters not yet built

**Monitoring Interface** (Abstract):

```typescript
interface MetricsExporter {
  exportRequestMetrics(metrics: RequestMetric[]): Promise<void>;
  exportAggregates(aggregates: AggregateMetric[]): Promise<void>;
  flush(): Promise<void>;
}
```

**Built-in Exporters**:

- [ ] D1 Exporter (default, already implemented)
- [ ] Prometheus Exporter (pull-based)
- [ ] Cloudflare Analytics Engine (push-based)
- [ ] Webhook Exporter (generic HTTP POST)

**Configuration** (per tenant):

```jsonc
{
  "monitoring": {
    "enabled": true,
    "exporters": [
      { "type": "d1" },
      { "type": "prometheus", "endpoint": "https://metrics.example.com" },
      { "type": "webhook", "url": "https://monitoring.example.com/ingest" },
    ],
  },
}
```

**Files to Create**:

- `src/metrics/exporter.ts` (interface)
- `src/metrics/exporters/d1-exporter.ts`
- `src/metrics/exporters/prometheus-exporter.ts`
- `src/metrics/exporters/webhook-exporter.ts`

#### 3.3 Cost Tracking & Quotas ✓ Priority: HIGH

**Features**:

- [x] Track cumulative cost per tenant (daily, monthly) — `request_metrics` rows written by the chat path with per-model pricing (`getModelPricing`)
- [x] Set spending limits per tenant — `PUT /api/usage/limits` (stored in `tenant_settings.spendLimits`)
- [x] Alert when approaching limit (80%, 90%, 100%) — `GET /api/usage/alerts`
- [x] Auto-disable tenant when limit exceeded — post-request check (`maybeDisableAfterSpend`) sets `spendDisabledUntil`; requests return `402 spend_limit_exceeded` until the window rolls over or limits are raised
- [x] Per-key spend caps — `api_keys.scopes.spendCapUsd` (lifetime cap) enforced the same way
- [x] Cost breakdown by provider and model — `GET /api/metrics/costs` / `GET /api/usage/costs`

**API Endpoints**:

- `GET /api/usage/costs` — daily cost breakout + totals
- `PUT /api/usage/limits` — daily/monthly spend limits (null clears)
- `GET /api/usage/alerts` — spend vs limit at 80/90/100%
- `GET /api/metrics/costs` / `GET /api/metrics/recent`

**Files**:

- `src/metrics/cost-tracker.ts` (pricing + aggregation)
- `src/metrics/request-logger.ts` (ingestion via `waitUntil`)
- `src/metrics/spend-guard.ts` (block/pre-check + post-check disable + reconcile)
- `src/durable/metrics-buffer.ts` (batching DO → D1)
- `src/api/usage.ts`, `src/api/metrics.ts`

### Phase 4: Performance & Scale (Weeks 7-8)

#### 4.1 Response Caching (Durable Objects) ✓ Priority: LOW

**Features**:

- [x] Cache hit/miss instrumentation — hit/miss recorded on `request_metrics.cache_hit`
- [x] Semantic cache for identical requests — opt-in (`settings.cache.enabled`), non-streaming only; content-addressed keys (`SHA-256(org + stableStringify(body))`)
- [x] Cache key: hash(tenant, provider, model, messages)
- [x] TTL-based expiration (configurable per tenant — `settings.cache.ttl`, default 3600s)
- [ ] Cache invalidation API

**Durable Object**: `ResponseCache`

**Configuration**:

```jsonc
{
  "cache": {
    "enabled": true,
    "ttl": 3600, // seconds
    "maxSize": 100, // MB per tenant
  },
}
```

**Files to Create**:

- `src/cache/response-cache.ts`
- `src/cache/cache-key.ts`

#### 4.2 Rate Limiting (Durable Objects) ✓ Priority: HIGH

**Features**:

- [x] Rate limit per tenant (requests per minute) — `requests:org:*` bucket
- [x] Rate limit per API key (requests per minute) — `requests:key:*` bucket
- [x] Token-based rate limiting (tokens per minute) — `tokens:org:*` bucket (peek on `max_tokens`, actual usage settled post-request)
- [ ] Configurable limits per tenant tier — limits come from `tenant_settings.rateLimit`; tier-based mapping not implemented
- [x] Return 429 with Retry-After header — `rate_limit_exceeded`

**Durable Object**: `RateLimiter`

**Algorithm**: Token bucket

**Sharding**: Hash-shard by `hash(tenant + apiKey)` across N Durable Objects from day one — a single DO per tenant bottlenecks at ~100 req/s and would become the ceiling for hot tenants

**Configuration**:

```jsonc
{
  "rateLimit": {
    "requestsPerMinute": 60,
    "tokensPerMinute": 100000,
    "burstSize": 10,
  },
}
```

**Files to Create**:

- `src/cache/rate-limiter.ts`
- `src/middlewares/rate-limit.ts`

#### 4.3 Session Affinity (Durable Objects) ✓ Priority: LOW

**Features**:

- [ ] WebSocket connection pooling for OpenAI Codex
- [ ] Session ID tracking
- [ ] Connection reuse (5-minute idle timeout)
- [ ] Automatic reconnection on failure

**Durable Object**: `SessionManager`

**Files to Create**:

- `src/cache/session-manager.ts`

### Phase 5: Additional Features (Week 9+)

#### 5.1 OAuth Provider Support ✓ Priority: MEDIUM

**Features**:

- [ ] OAuth flow for Anthropic (Claude Pro)
- [ ] OAuth flow for OpenAI Codex (ChatGPT Plus/Pro)
- [ ] OAuth flow for GitHub Copilot
- [ ] Store OAuth tokens securely
- [ ] Automatic token refresh

**UI Flow**:

1. User clicks "Connect Claude Pro"
2. Redirect to Anthropic OAuth
3. User authorizes
4. Store token in D1 (encrypted)
5. Pi-AI uses token for requests

> **Note**: pi-ai's OAuth login flows are Node-only. Validate that its device-code flow runs on the Workers runtime (`workerd`) early; if not, run OAuth login through a Node-compat sidecar/separate Worker and persist the resulting token in D1.

**Files to Create**:

- `src/auth/oauth-flows.ts`
- `src/api/oauth-callback.ts`

#### 5.2 Audit Logging ✓ Priority: LOW

**Features**:

- [ ] Log all admin actions (create/update/delete)
- [ ] Log authentication events
- [ ] Log API key usage
- [ ] Queryable audit log

**Files to Create**:

- `src/audit/audit-logger.ts`
- `src/api/audit-logs.ts`

#### 5.3 Webhook Notifications ✓ Priority: LOW

**Features** (implemented):

- [x] Webhook on quota exceeded — `quota_exceeded` event (spend_daily/spend_monthly at 80/90/100%)
- [x] Webhook on high error rate — `high_error_rate` event
- [x] Configurable webhook URLs per tenant — `webhooks` table + `/api/alerts/webhooks*` CRUD
- [x] Optional HMAC-SHA256 signature (`x-open-llm-proxy-signature: sha256=<hex>`) via per-subscription `secret`
- [x] Alert history — `alert_events` ledger + `GET /api/alerts/events`

**Files to Create**:

- `src/alerts/evaluator.ts` (cron check: spend + error-rate), `src/alerts/webhooks.ts` (subscriptions + delivery), `src/alerts/config.ts`, `src/api/alerts.ts` (config/webhooks/events/test), `alert_events` table in `migrations/0003_app.sql`, `test/src/alerts/alerting.test.ts`

---

## Database Schema

### D1 Schema (SQLite)

```sql
-- Tenants
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settings TEXT, -- JSON: rate limits, cache config, etc.
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'deleted'))
);

-- Users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Tenant memberships
CREATE TABLE tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX idx_tenant_users_tenant ON tenant_users(tenant_id);
CREATE INDEX idx_tenant_users_user ON tenant_users(user_id);
```

```sql
-- Sessions (source of truth in D1; served from a KV read-through cache on the hot path)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER, -- set on logout; the KV cache entry is deleted at the same time
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- API Keys (for programmatic access)
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL, -- Hash of the key shown once
  key_prefix TEXT NOT NULL, -- First 8 chars for display
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- Provider configurations
CREATE TABLE provider_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL, -- 'openai', 'anthropic', etc.
  enabled INTEGER DEFAULT 1,
  config TEXT NOT NULL, -- JSON: encrypted API keys, settings
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, provider)
);

CREATE INDEX idx_provider_configs_tenant ON provider_configs(tenant_id);
```

```sql
-- Request metrics
CREATE TABLE request_metrics (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  api_key_id TEXT,
  timestamp INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  method TEXT NOT NULL, -- 'chat', 'completion', 'embedding'
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_cached INTEGER,
  cost_usd REAL,
  error_message TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_metrics_tenant_timestamp ON request_metrics(tenant_id, timestamp DESC);
CREATE INDEX idx_metrics_provider ON request_metrics(provider, timestamp DESC);

-- Audit logs
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL, -- 'create', 'update', 'delete'
  resource_type TEXT NOT NULL, -- 'provider', 'api_key', 'user'
  resource_id TEXT,
  details TEXT, -- JSON
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_audit_tenant_timestamp ON audit_logs(tenant_id, timestamp DESC);
```

---

## API Specification

### Authentication APIs

#### POST /api/auth/register

Register a new user and create their first tenant.

**Request**:

```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "name": "John Doe",
  "tenantName": "My Company"
}
```

**Response** (201):

```json
{
  "user": {
    "id": "usr_abc123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "tenant": {
    "id": "ten_xyz789",
    "name": "My Company",
    "slug": "my-company",
    "role": "owner"
  }
}
```

#### POST /api/auth/login

Authenticate user and create session.

**Request**:

```json
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response** (200):

```json
{
  "user": {
    "id": "usr_abc123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "tenants": [
    {
      "id": "ten_xyz789",
      "name": "My Company",
      "slug": "my-company",
      "role": "owner"
    }
  ]
}
```

**Sets Cookie**: `session=<token>; HttpOnly; Secure; SameSite=Strict; path=/; Max-Age=604800`

> **Origin model**: the dashboard (Pages) and the API (Worker) must share a registrable domain, with the cookie scoped to it (e.g. `Domain=example.com`), or `SameSite=Strict` will block the cookie between `dashboard.example.com` ↔ `api.example.com`. Simplest option: serve the dashboard and API from one Worker origin.

#### POST /api/auth/logout

Invalidate current session.

**Response** (200):

```json
{
  "success": true
}
```

### Tenant APIs

#### GET /api/tenants/:id/providers

List all configured providers for tenant.

**Response** (200):

```json
{
  "providers": [
    {
      "provider": "openai",
      "enabled": true,
      "hasKeys": true,
      "keyCount": 2,
      "defaultModel": "gpt-4o-mini",
      "updatedAt": 1705000000
    },
    {
      "provider": "anthropic",
      "enabled": true,
      "hasKeys": true,
      "keyCount": 1,
      "defaultModel": "claude-sonnet-4-5",
      "updatedAt": 1705000000
    }
  ]
}
```

#### POST /api/tenants/:id/providers/:provider/config

Configure provider for tenant.

**Request**:

```json
{
  "enabled": true,
  "apiKeys": ["sk-...abc123", "sk-...def456"],
  "defaultModel": "gpt-4o-mini",
  "settings": {
    "rotationStrategy": "round-robin",
    "timeout": 30000
  }
}
```

**Response** (200):

```json
{
  "success": true,
  "provider": "openai",
  "enabled": true,
  "keyCount": 2
}
```

### Open LLM Proxy APIs (OpenAI-Compatible)

#### POST /v1/chat/completions

Standard OpenAI-compatible chat completion endpoint.

**Headers**:

- `Authorization: Bearer <TENANT_API_KEY>`

**Request**:

```json
{
  "model": "openai/gpt-4o-mini",
  "messages": [{ "role": "user", "content": "Hello!" }],
  "stream": false
}
```

**Response** (200):

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1705000000,
  "model": "gpt-4o-mini",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 15,
    "total_tokens": 25
  }
}
```

### Metrics APIs

#### GET /api/tenants/:id/metrics/requests

Query request metrics.

**Query Parameters**:

- `start`: Start timestamp (Unix)
- `end`: End timestamp (Unix)
- `provider`: Filter by provider (optional)
- `model`: Filter by model (optional)
- `groupBy`: 'hour' | 'day' | 'week'

**Response** (200):

```json
{
  "metrics": [
    {
      "timestamp": 1705000000,
      "requests": 1250,
      "errors": 12,
      "avgLatencyMs": 850,
      "p95LatencyMs": 1500,
      "totalTokens": 125000,
      "totalCostUsd": 0.52
    }
  ],
  "summary": {
    "totalRequests": 5000,
    "totalErrors": 45,
    "errorRate": 0.009,
    "totalCostUsd": 2.15
  }
}
```

---

## Implementation Roadmap

### Week 1: Foundation Setup

**Goals**:

- D1 database created and migrated
- Basic tenant/user tables
- Authentication middleware skeleton

**Deliverables**:

- [ ] `wrangler.toml` updated with D1 binding
- [ ] `schema.sql` created and applied
- [ ] Basic tenant CRUD operations

**Dependencies**: None

**Risk**: Low

### Week 2: Auth + Pi-AI Integration

**Goals**:

- Working authentication system
- Pi-AI library integrated
- Basic provider routing functional

**Deliverables**:

- [ ] Login/register endpoints
- [ ] Session management
- [ ] Pi-AI Models factory
- [ ] D1-backed credential store
- [ ] Test chat completion with OpenAI

**Dependencies**: Week 1 complete

**Risk**: Medium (Pi-AI integration complexity)

### Week 3-4: Dashboard UI

**Goals**:

- Admin dashboard deployed
- Provider configuration UI
- API key management

**Deliverables**:

- [ ] React app scaffolded
- [ ] Login page
- [ ] Dashboard home
- [ ] Provider config page
- [ ] API key management page

**Dependencies**: Week 2 complete

**Risk**: Low

### Week 5-6: Metrics & Monitoring

**Goals**:

- Request logging functional
- Analytics dashboard
- Cost tracking

**Deliverables**:

- [ ] Request metrics middleware
- [ ] D1 metrics storage
- [ ] Analytics API endpoints
- [ ] Charts in dashboard
- [ ] Cost tracking and alerts

**Dependencies**: Week 4 complete

**Risk**: Low

### Week 7-8: Performance Optimization

**Goals**:

- Rate limiting per tenant (hash-sharded)
- Cache hit/miss instrumentation review
- Production-ready performance

**Deliverables**:

- [x] RateLimiter Durable Object (hash-sharded across N DOs — `rl:<hash(orgId)%RATE_LIMITER_SHARDS>`)
- [x] Cache hit/miss tracking (instrumentation only)
- [x] Rate limit enforcement (429 + Retry-After in the chat path)
- [x] ResponseCache Durable Object (opt-in per tenant, non-streaming)

**Dependencies**: Week 6 complete

**Risk**: Medium (Durable Objects state management)

### Week 9+: Polish & Advanced Features

**Goals**:

- OAuth provider support
- Audit logging
- Production deployment

**Deliverables**:

- [ ] OAuth flows (Anthropic, OpenAI Codex)
- [ ] Audit log system
- [ ] Production deployment guide
- [ ] Monitoring alerting

**Dependencies**: Week 8 complete

**Risk**: Low

---

## Migration Strategy

### From V1 to V2

#### Phase 1: Parallel Deployment (Week 0)

1. **Deploy V2 alongside V1**
   - New subdomain: `v2.proxy.example.com`
   - V1 continues at: `proxy.example.com`
   - No user impact

2. **Create migration script**
   - Convert V1 env vars to V2 tenant configs
   - Generate admin credentials
   - Import existing metrics (if any)

#### Phase 2: Internal Testing (Week 1-2)

1. **Test all features with dummy tenant**
   - Provider configuration
   - Request routing
   - Metrics collection
   - Dashboard functionality

2. **Performance benchmarking**
   - Compare V1 vs V2 latency
   - Verify no regressions
   - Load testing

#### Phase 3: Gradual Migration (Week 3-4)

1. **Invite early adopters**
   - Provide V2 credentials
   - Run in parallel with V1
   - Collect feedback

2. **Monitor both systems**
   - Track V1 vs V2 traffic
   - Compare error rates
   - Verify cost accuracy

#### Phase 4: Full Cutover (Week 5+)

1. **Migrate all users to V2**
   - Email notification with migration guide
   - Update DNS to point to V2
   - Keep V1 read-only for 1 week

2. **Decommission V1**
   - Archive V1 metrics
   - Shutdown V1 workers
   - Update documentation

### Backward Compatibility

**Maintained**:

- ✅ OpenAI-compatible endpoints (`/v1/chat/completions`)
- ✅ Pass-through routes (`/openai/chat/completions`)
- ✅ Model format (`provider/model`)
- ✅ Response format (same as V1)

**Breaking Changes**:

- ❌ `PROXY_API_KEY` env var → Tenant API keys in dashboard
- ❌ Global provider config → Per-tenant config in D1
- ❌ Single auth → Multi-user auth with sessions
- ❌ Config-file/secrets deployment (`config.jsonc`, `scripts/*`) → self-serve bootstrap (D1-backed secrets + seeded initial admin)

---

## Monitoring & Observability

### Key Metrics to Track

#### Application Metrics

- **Request Rate**: Requests per second per tenant
- **Latency**: p50, p95, p99 per provider
- **Error Rate**: Errors per minute per provider
- **Cache Hit Rate**: % of requests served from cache
- **Token Usage**: Tokens per hour per tenant

#### Business Metrics

- **Cost per Tenant**: Daily/monthly LLM API costs
- **Revenue per Tenant**: If implementing billing
- **Active Users**: Daily/monthly active users per tenant
- **Provider Distribution**: Which providers are most used

#### Infrastructure Metrics

- **Worker CPU Time**: Track CPU time per request
- **D1 Query Latency**: Database query performance
- **Durable Object Latency**: DO operation latency
- **Memory Usage**: Peak memory per request

### Alerting Strategy

#### Critical Alerts (Page immediately)

- **System Down**: > 50% error rate for 2 minutes
- **Provider Outage**: 100% errors for specific provider for 5 minutes
- **Database Failure**: D1 queries failing for 1 minute
- **Security Breach**: Multiple failed auth attempts from single IP

#### Warning Alerts (Slack/Email)

- **High Error Rate**: > 5% errors for 10 minutes
- **High Latency**: p95 > 5s for 10 minutes
- **Quota Exceeded**: Tenant approaching spending limit
- **Cache Hit Rate Observation**: once response caching ships, alert if hit rate is unexpectedly low (e.g. 0% while caching is enabled)

#### Info Alerts (Dashboard only)

- **New Tenant Signup**
- **Provider Configuration Changed**
- **API Key Created/Revoked**

### External Monitoring Integration

**Prometheus Exporter** (`/metrics` endpoint):

```
# Metrics exposed for scraping
open_llm_proxy_requests_total{tenant, provider, model, status}
open_llm_proxy_latency_seconds{tenant, provider, quantile}
open_llm_proxy_tokens_total{tenant, provider, type}
open_llm_proxy_cost_usd_total{tenant, provider}
open_llm_proxy_cache_hit_rate{tenant}
```

**Webhook Integration**:

```json
POST https://monitoring.example.com/webhook
{
  "event": "quota_exceeded",
  "tenant_id": "ten_xyz789",
  "details": {
    "current_spend": 100.50,
    "limit": 100.00,
    "period": "monthly"
  },
  "timestamp": 1705000000
}
```

---

## Security Considerations

### Credential Encryption

**At Rest**:

- Provider API keys encrypted in D1 using AES-256-GCM
- Master key (KEK) stored in Cloudflare Workers Secret
- Recommended: envelope encryption — generate a per-tenant data-encryption key (DEK), wrap it with the KEK, and store the wrapped DEK in D1. Limits blast radius if a single key leaks and enables per-tenant key rotation

**In Transit**:

- All connections over HTTPS/TLS 1.3
- Certificate pinning for provider APIs
- No credentials logged or exposed in errors

**Implementation**:

```typescript
// src/tenants/crypto.ts
interface EncryptedCredential {
  encrypted: string; // Base64 encrypted data
  iv: string; // Initialization vector
  salt: string; // Tenant-specific salt
  algorithm: "AES-256-GCM";
}
```

**Envelope Encryption (Recommended)**:

- KEK: master key from a Workers Secret — never persisted in D1
- Per tenant: generate a DEK, wrap it with the KEK, store only the wrapped DEK + IV in D1
- DEK is unwrapped in-memory per tenant and used for AES-256-GCM on credentials; re-wrap on rotation

```typescript
interface EnvelopeEncryptedCredential extends EncryptedCredential {
  wrappedDek: string; // DEK encrypted with the KEK (base64)
  kekVersion: number; // enables KEK rotation
}
```

### Authentication Security

**Password Requirements**:

- Minimum 12 characters
- Must include: uppercase, lowercase, number, special char
- PBKDF2-SHA256 via Workers WebCrypto (`crypto.subtle.deriveBits`), 100k+ iterations, salted per-user
- (Note: Argon2 is not in the Workers WebCrypto surface and napi/native addons are unsupported by workerd. If Argon2id is desired later, use a pre-compiled WASM build — `argon2-wasm-edge`/`hash-wasm` — with parameters tuned to Workers memory/CPU limits)

**Session Security**:

- HttpOnly cookies (no JavaScript access)
- Secure flag (HTTPS only)
- SameSite=Strict (CSRF protection)
- 7-day expiry with sliding window
- Session token: 256-bit cryptographically secure random
- Lookup served from the KV read-through cache; D1 is the source of truth
- KV is eventually consistent (up to ~60s): a just-revoked session may validate briefly on the fast path. Mitigate with a short KV TTL and re-verify against D1 **only for admin/management actions** (role changes, key create/delete, provider config changes). The LLM request hot path uses the KV lookup alone — a D1 re-verify on every request would violate the < 5ms auth target

**API Key Security**:

- SHA-256 hashed before storage
- Only show full key once on creation
- Store only prefix for display (first 8 chars)
- Support key expiration dates
- Rate limit key creation (max 10 per tenant)
- Optional per-key scoping: allowed providers/models, spend cap, IP allowlist

### RBAC Permissions Matrix

| Action              | Owner | Admin | Member | Viewer |
| ------------------- | ----- | ----- | ------ | ------ |
| View dashboard      | ✅    | ✅    | ✅     | ✅     |
| Make LLM requests   | ✅    | ✅    | ✅     | ❌     |
| View metrics        | ✅    | ✅    | ✅     | ✅     |
| Configure providers | ✅    | ✅    | ❌     | ❌     |
| Create API keys     | ✅    | ✅    | ❌     | ❌     |
| Invite users        | ✅    | ✅    | ❌     | ❌     |
| Manage users        | ✅    | ✅    | ❌     | ❌     |
| Change settings     | ✅    | ❌    | ❌     | ❌     |
| Delete tenant       | ✅    | ❌    | ❌     | ❌     |

### Input Validation & Sanitization

**API Request Validation**:

- Validate all JSON payloads against schemas
- Sanitize user inputs (tenant names, emails)
- Rate limit registration endpoints (prevent spam)
- Validate email format and domain
- Block disposable email services (optional)

**SQL Injection Prevention**:

- Use D1 prepared statements exclusively
- Never concatenate user input into SQL
- Validate all IDs (UUIDs only)

**XSS Prevention**:

- CSP headers on dashboard
- Sanitize all rendered user content
- No eval() or innerHTML usage

---

## Performance Targets

### Latency Targets

| Metric               | Target | Measurement               |
| -------------------- | ------ | ------------------------- |
| Auth check           | < 5ms  | p99                       |
| DB read (cached)     | < 10ms | p95                       |
| DB write             | < 50ms | p95                       |
| LLM request overhead | < 20ms | p95 (proxy overhead only) |
| Dashboard page load  | < 2s   | p95                       |

### Throughput Targets

| Metric              | Target  | Notes                      |
| ------------------- | ------- | -------------------------- |
| Requests per second | 1,000+  | Per worker instance        |
| Concurrent tenants  | 10,000+ | With proper DO sharding    |
| Metrics writes/sec  | 500+    | Batched writes to D1       |
| Dashboard users     | 100+    | Concurrent dashboard users |

### Resource Limits

**Cloudflare Workers**:

- CPU time: < 100ms per request (target: 30ms)
- Memory: < 64MB per request
- Subrequests: < 10 per request

**D1 Database**:

- Query time: < 100ms per query (target: 20ms)
- Concurrent connections: Managed by Cloudflare
- Database size: Up to 10GB (scale with multiple D1 instances if needed)

**Durable Objects**:

- Memory per DO: < 128MB
- Concurrent requests per DO: < 100
- State storage: < 10MB per DO

---

## Cost Estimation

### Cloudflare Costs (Workers Paid Plan)

**Workers**:

- $5/month base
- $0.30 per million requests after 10M
- $0.02 per million CPU-ms after 30M

**D1 Database**:

- First 5M rows read: Free
- $0.001 per 1,000 rows read after 5M
- $1.00 per 1M rows written

**Durable Objects**:

- $0.15 per million requests
- $0.20 per GB-month storage

**Example Monthly Cost** (10K requests/day, 100 tenants):

- Workers: $5 base
- D1: ~$2 (mostly writes for metrics)
- Durable Objects: ~$5 (rate limiting + caching)
- **Total: ~$12/month**

**Scaling** (1M requests/day, 1000 tenants):

- Workers: $5 + $9 = $14
- D1: ~$20-$30 (heavier metrics writes; 1M req/day ≈ 30M metric rows/month at ~$1/1M writes — DO batching and sampling reduce this)
- Durable Objects: ~$50
- **Total: ~$84/month**

### LLM Provider Costs (Pass-through)

This proxy does not markup LLM costs. Users pay:

- OpenAI: $0.150-$0.600 per 1M tokens (GPT-4o)
- Anthropic: $3.00-$15.00 per 1M tokens (Claude 3.5)
- Google: $0.075-$1.25 per 1M tokens (Gemini)

The proxy tracks these costs and can enforce limits per tenant.

---

## Technology Stack Summary

### Backend

- **Runtime**: Cloudflare Workers (V8 isolates)
- **Language**: TypeScript 5.x
- **Database**: Cloudflare D1 (SQLite)
- **State Management**: Durable Objects
- **LLM Integration**: `@earendil-works/pi-ai` + retained V1 provider layer as native-fetch fallback
- **Auth**: Custom (PBKDF2-SHA256 + session cookies with D1/KV storage)

### Frontend (Dashboard)

- **Framework**: React 18 + TypeScript
- **Routing**: TanStack Router
- **State Management**: TanStack Query
- **UI Components**: shadcn/ui + Tailwind CSS
- **Charts**: Recharts
- **Deployment**: Cloudflare Pages

### Development Tools

- **Build**: Wrangler 3.x
- **Testing**: Vitest
- **Linting**: ESLint + Prettier
- **Type Checking**: TypeScript strict mode
- **CI/CD**: GitHub Actions

---

## Risk Assessment

### High Risk Items

| Risk                                       | Impact                             | Mitigation                                                                 |
| ------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------- |
| **Pi-AI bundle size exceeds limit**        | Can't deploy                       | Selective provider imports, CI bundle-size gate in Phase 1                 |
| **Pi-AI OAuth flows don't run on Workers** | OAuth provider feature unavailable | Validate device-code flow early on `workerd`; Node-compat sidecar fallback |
| **D1 query latency too high**              | Poor UX                            | Add indexes, cache frequently accessed data in DO                          |
| **Credential encryption key leaked**       | Data breach                        | Store key in Workers Secret, rotate periodically                           |
| **Provider API changes break proxy**       | Service outage                     | Use pi-ai (handles API changes), version lock dependencies                 |

### Medium Risk Items

| Risk                                       | Impact                         | Mitigation                                               |
| ------------------------------------------ | ------------------------------ | -------------------------------------------------------- |
| **Durable Objects state loss**             | Cache misses, rate limit reset | Design to tolerate state loss, rebuild from D1           |
| **Metrics write volume exceeds D1 limits** | Metrics dropped                | Batch writes, sample high-volume tenants                 |
| **Cross-tenant data leak**                 | Security issue                 | Strict tenant isolation tests, audit all queries         |
| **Session token theft**                    | Account compromise             | HttpOnly cookies, short expiry, IP validation (optional) |

### Low Risk Items

| Risk                             | Impact          | Mitigation                                   |
| -------------------------------- | --------------- | -------------------------------------------- |
| **Dashboard deployment failure** | UI unavailable  | Separate deployment, fallback to API only    |
| **OAuth provider changes terms** | OAuth broken    | Document alternatives, maintain API key path |
| **Cost tracking inaccurate**     | Budget overruns | Regular audits, compare with provider bills  |

---

## Testing Strategy

### Unit Tests

- All service classes (`src/**/*.test.ts`)
- Crypto functions (encryption/decryption)
- Metrics calculations
- Cost tracking logic
- **Target Coverage**: 80%+

### Integration Tests

- D1 queries with test database
- Pi-AI provider routing
- Auth flows (register, login, logout)
- API endpoint responses
- **Target Coverage**: Core paths covered

### End-to-End Tests

- Full user journey (register → configure → request)
- Dashboard UI flows
- Multi-tenant isolation
- Rate limiting enforcement
- **Tool**: Playwright

### Load Tests

- Simulate 1000 req/s per worker
- 100 concurrent tenants
- Verify latency targets
- Check for memory leaks
- **Tool**: k6 or Artillery

---

## Open Questions & Future Considerations

### To Be Decided

1. **Frontend Framework Choice**
   - React (most ecosystem support)
   - Vue (lighter bundle)
   - Svelte (best performance)
   - **Recommendation**: React 18 + Vite + shadcn/ui — largest ecosystem and hiring pool, and the best-maintained component library; dashboard bundle size is not a material concern for an internal admin UI
   - **Decision needed by**: Week 2

2. **Billing Integration**
   - Stripe for subscription management?
   - Usage-based pricing model?
   - **Decision needed by**: Phase 5

3. **Multi-Region Support**
   - Deploy to multiple Cloudflare regions?
   - Region-specific D1 instances?
   - **Decision needed by**: After V2 launch

4. **AI Gateway Integration**
   - Keep existing Cloudflare AI Gateway support?
   - Conflicts with multi-tenancy?
   - **Recommendation**: Keep it, optional per tenant. pi-ai ships a first-class `cloudflare-ai-gateway` provider, so it composes with the tenant-scoped model factory.
   - **Decision needed by**: Week 3

### Future Enhancements (Post-V2)

1. **Advanced Features**
   - Request/response transformation rules
   - Custom middleware plugins
   - Tenant-specific rate limits per model
   - Budget alerts via email/SMS
   - Slack integration for alerts

2. **Enterprise Features**
   - SSO/SAML authentication
   - Audit log export (CSV, JSON)
   - Compliance certifications (SOC 2, GDPR)
   - SLA guarantees
   - Dedicated support

3. **Developer Experience**
   - SDK libraries (Python, Node.js, Go)
   - Terraform provider
   - CLI tool for management
   - OpenAPI spec generation
   - Webhooks for all events

4. **Scale & Performance**
   - Multi-region active-active deployment
   - Edge caching with Cloudflare Cache API
   - Provider health checks and auto-failover
   - Request queuing for rate-limited providers
   - Intelligent model routing (cost vs latency)

---

## Conclusion

This V2 architecture transforms the Open LLM Proxy from a single-tenant utility into a **production-ready, multi-tenant SaaS platform**. The design prioritizes:

✅ **Security**: Encrypted credentials, RBAC, audit logging
✅ **Scalability**: Multi-tenant isolation, Durable Objects, edge deployment
✅ **Observability**: Comprehensive metrics, cost tracking, alerting
✅ **Developer Experience**: Pi-AI integration, OpenAI compatibility, clean APIs
✅ **Maintainability**: Modular architecture, clear separation of concerns

**Estimated Timeline**: 8-9 weeks for V2.0 launch
**Estimated Cost**: $12-$84/month depending on scale (Cloudflare only)
**Bundle Size Target**: < 2 MB (achievable with selective pi-ai imports)

**Next Steps**:

1. Review and approve this design document
2. Set up development environment (D1, Durable Objects)
3. Begin Phase 1 implementation (Foundation)
4. Weekly progress reviews

---

## Appendix

### Useful Links

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [D1 Documentation](https://developers.cloudflare.com/d1/)
- [Durable Objects Guide](https://developers.cloudflare.com/durable-objects/)
- [Pi-AI GitHub](https://github.com/earendil-works/pi/tree/main/packages/ai)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)

### Glossary

- **DO**: Durable Objects (Cloudflare's stateful compute)
- **D1**: Cloudflare's distributed SQLite database
- **RBAC**: Role-Based Access Control
- **Pi-AI**: Unified LLM API library (`@earendil-works/pi-ai`, published from the earendil-works/pi monorepo; formerly badlogic/pi-mono)
- **Tenant**: An organization/company using the proxy
- **Provider**: LLM API provider (OpenAI, Anthropic, etc.)

---

**Document Version**: 2.0.0
**Last Updated**: 2026-08-17
**Status**: ✅ **COMPLETE - Ready for Review**
