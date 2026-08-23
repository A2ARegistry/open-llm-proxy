-- ============================================
-- Open LLM Proxy - Application Tables
-- All tenant-scoped tables reference organizations(id)
-- (Better Auth organization plugin = the tenant model)
-- ============================================

-- Per-tenant organization settings (key/value JSON, tenant-scoped)
CREATE TABLE IF NOT EXISTS tenant_settings (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL, -- JSON
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (organization_id, key)
);
CREATE INDEX IF NOT EXISTS idx_tenant_settings_org ON tenant_settings(organization_id);

-- Programmatic API keys (for the Open LLM Proxy path)
CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the full key (only shown once)
    key_prefix TEXT NOT NULL,        -- first 8 chars for display
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_used_at INTEGER,
    expires_at INTEGER,
    spend_disabled_until INTEGER, -- unix ts key is auto-disabled at when scopes.spendCapUsd is exceeded (NULL = not disabled)
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
    scopes TEXT NOT NULL DEFAULT '{}' -- JSON: { providers?: string[], models?: string[], spendCapUsd?: number, ipAllowlist?: string[] }
);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(organization_id, status);

-- Provider configurations per tenant
CREATE TABLE IF NOT EXISTS provider_configs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, -- 'openai', 'anthropic', 'custom-openai', ...
    name TEXT NOT NULL DEFAULT '', -- display name (e.g., 'Google Vertex Provider 2')
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL,   -- JSON: encrypted keys (envelope), settings
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(organization_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_provider_configs_org ON provider_configs(organization_id);

-- Envelope-encryption DEK cache (wrapped by the KEK secret; never stores raw keys)
CREATE TABLE IF NOT EXISTS tenant_keys (
    organization_id TEXT NOT NULL PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    wrapped_dek TEXT NOT NULL,  -- base64 DEK wrapped with the KEK (AES-256-GCM)
    wrapped_dek_iv TEXT NOT NULL DEFAULT '', -- base64 IV used when wrapping the DEK
    kek_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Request metrics
CREATE TABLE IF NOT EXISTS request_metrics (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT,               -- session user, or NULL for API-key traffic
    api_key_id TEXT,            -- API key id if programmatic
    timestamp INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    method TEXT NOT NULL,       -- 'chat', 'completion', 'embedding'
    status_code INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    tokens_input INTEGER,
    tokens_output INTEGER,
    tokens_cached INTEGER,
    tokens_cache_read INTEGER,
    tokens_cache_write INTEGER,
    cost_usd REAL,
    error_message TEXT,
    cache_hit INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_org_ts ON request_metrics(organization_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_provider_ts ON request_metrics(provider, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_org_provider_ts ON request_metrics(organization_id, provider, timestamp DESC);

-- Audit logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE, -- NULL for system-wide events (e.g. sign-in)
    user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,       -- 'create', 'update', 'delete', 'auth'
    resource_type TEXT NOT NULL, -- 'provider', 'api_key', 'user', 'tenant', 'session', ...
    resource_id TEXT,
    details TEXT,               -- JSON
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_logs(organization_id, timestamp DESC);

-- Webhook subscriptions (Phase 5)
CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]', -- JSON array: quota_exceeded, high_error_rate, provider_failure
    secret TEXT,  -- HMAC secret for signature verification
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(organization_id);

-- OAuth provider tokens (Phase 5), encrypted at rest
CREATE TABLE IF NOT EXISTS oauth_credentials (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,   -- 'anthropic', 'openai-codex', 'github-copilot'
    credential TEXT NOT NULL, -- JSON envelope-encrypted token bundle
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(organization_id, provider)
);

-- Email settings (content-emailing companion uses its own system_email_* tables from 0002)
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Model pricing table (used for cost tracking)
CREATE TABLE IF NOT EXISTS model_pricing (
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_per_1m REAL NOT NULL DEFAULT 0,
    output_per_1m REAL NOT NULL DEFAULT 0,
    cache_read_per_1m REAL NOT NULL DEFAULT 0,
    cache_write_per_1m REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (provider, model)
);
CREATE INDEX IF NOT EXISTS idx_model_pricing_provider ON model_pricing(provider);

-- Alert delivery ledger: one row per delivery attempt so the scheduled
-- evaluator can dedup within a cooldown window (org + type + provider + level)
-- and the dashboard can show recent alert history.
CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider TEXT,
  level REAL NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  message_id TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_events_dedup
  ON alert_events(organization_id, event_type, provider, level, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_org_created
  ON alert_events(organization_id, created_at DESC);
