-- [fork] W12: live history of the self-hosted box (inference server + host).
-- resolution_s 10  = raw samples (14 columns of data, `samples` and *_max NULL).
-- resolution_s 600 = 10-minute rollups: avg columns are AVG of the ok=1 raw
--                    rows, *_max the MAX, `samples` the count of those rows.
-- ts is unix seconds (sample time, or bucket start for rollups).
-- Throughput is not stored per 10 s: it is computed from request_metrics.
CREATE TABLE inference_samples (
  binding TEXT NOT NULL,
  resolution_s INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  samples INTEGER,
  slots INTEGER,
  version TEXT,
  in_flight REAL,
  queued REAL,
  longest_wait_s REAL,
  kv_usage_ratio REAL,
  kv_reserved_tokens REAL,
  cache_hit_ratio REAL,
  cache_saved_tps REAL,
  draft_accept_ratio REAL,
  in_flight_max REAL,
  queued_max REAL,
  longest_wait_s_max REAL,
  kv_usage_ratio_max REAL,
  PRIMARY KEY (binding, resolution_s, ts)
) WITHOUT ROWID;

CREATE TABLE host_samples (
  binding TEXT NOT NULL,
  resolution_s INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  samples INTEGER,
  cpu_busy_pct REAL,
  mem_used_bytes REAL,
  mem_total_bytes REAL,
  gpu_busy_pct REAL,
  gpu_mem_used_bytes REAL,
  gpu_mem_total_bytes REAL,
  cpu_temp_c REAL,
  gpu_temp_c REAL,
  ssd_temp_c REAL,
  gpu_power_w REAL,
  cpu_busy_pct_max REAL,
  gpu_busy_pct_max REAL,
  mem_used_bytes_max REAL,
  gpu_mem_used_bytes_max REAL,
  cpu_temp_c_max REAL,
  gpu_temp_c_max REAL,
  gpu_power_w_max REAL,
  PRIMARY KEY (binding, resolution_s, ts)
) WITHOUT ROWID;

-- 10-minute request throughput per organization, recomputed from
-- request_metrics by the cron rollup. Never pruned.
CREATE TABLE throughput_rollups (
  organization_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  decode_tps REAL,
  decode_tps_max REAL,
  prefill_tps REAL,
  prefill_tps_max REAL,
  requests INTEGER NOT NULL,
  PRIMARY KEY (organization_id, ts)
) WITHOUT ROWID;
