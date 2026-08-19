-- Email System Schema

-- System email templates table
CREATE TABLE IF NOT EXISTS system_email_templates (
  template_id TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  template_type TEXT NOT NULL,
  subject_template TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  variables TEXT, -- JSON array
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_by TEXT
);

-- System email preferences table
CREATE TABLE IF NOT EXISTS system_email_preferences (
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  email_settings TEXT NOT NULL DEFAULT '{}',
  unsub_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (user_id, tenant_id)
);

-- System email sends table
CREATE TABLE IF NOT EXISTS system_email_sends (
  send_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  email_kind TEXT NOT NULL,
  period_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  provider_message_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  UNIQUE(user_id, email_kind, period_key)
);

-- System email events table
CREATE TABLE IF NOT EXISTS system_email_events (
  event_id TEXT PRIMARY KEY,
  send_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  email_kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (send_id) REFERENCES system_email_sends(send_id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_system_email_templates_type ON system_email_templates(template_type, is_active);
CREATE INDEX IF NOT EXISTS idx_system_email_preferences_tenant ON system_email_preferences(tenant_id);
CREATE INDEX IF NOT EXISTS idx_system_email_preferences_unsub_token ON system_email_preferences(unsub_token);
CREATE INDEX IF NOT EXISTS idx_system_email_sends_user ON system_email_sends(user_id);
CREATE INDEX IF NOT EXISTS idx_system_email_sends_period ON system_email_sends(email_kind, period_key);
CREATE INDEX IF NOT EXISTS idx_system_email_events_send ON system_email_events(send_id);

-- =========================================================
-- Email Logs: Comprehensive tracking of all email sends
-- =========================================================
-- Use this table to track every email sent, with status, 
-- provider info, and error handling. Supports batch emails via batch_id.

CREATE TABLE IF NOT EXISTS system_email_logs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    batch_id TEXT,                              -- Groups multiple recipients in same send
    recipient_email TEXT NOT NULL,              -- Email address sent to
    recipient_user_id TEXT,                     -- User ID if known (NULL for invitations)
    template_id TEXT NOT NULL,                  -- e.g., 'tmpl_verify_email', 'direct'
    subject TEXT,                               -- Rendered subject line
    status TEXT NOT NULL DEFAULT 'pending',     -- 'pending', 'sent', 'failed', 'bounced', 'complained'
    provider TEXT,                              -- 'resend', 'sendgrid', 'mailchannels', etc.
    provider_message_id TEXT,                   -- ID from email provider for tracking/webhooks
    error_message TEXT,                         -- Failure reason if status = 'failed'
    error_code TEXT,                            -- Provider error code if available
    metadata TEXT,                              -- JSON for extra context (org name, etc.)
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    sent_at INTEGER                             -- When successfully delivered to provider
);

-- Email logs indexes for common queries
CREATE INDEX IF NOT EXISTS idx_email_logs_recipient ON system_email_logs(recipient_email);
CREATE INDEX IF NOT EXISTS idx_email_logs_user ON system_email_logs(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_template ON system_email_logs(template_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_status ON system_email_logs(status);
CREATE INDEX IF NOT EXISTS idx_email_logs_batch ON system_email_logs(batch_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_created ON system_email_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_provider_msg ON system_email_logs(provider_message_id);
