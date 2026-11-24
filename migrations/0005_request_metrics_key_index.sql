-- Request log filtered by API key (dashboard request explorer, key detail).
CREATE INDEX IF NOT EXISTS idx_metrics_org_key_ts ON request_metrics(organization_id, api_key_id, timestamp DESC);
