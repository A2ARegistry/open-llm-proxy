export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  scopes: {
    providers?: string[];
    models?: string[];
    spendCapUsd?: number;
    ipAllowlist?: string[];
    defaultProvider?: string;
  };
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdBy: string;
  endpoint?: string;
}

export interface TenantInfo {
  organizationId: string;
  isRoot: boolean;
  systemPrefix: string | null;
  customPrefix: string | null;
  basePath: string;
}

export interface ProviderView {
  provider: string;
  name: string;
  mode: string;
  configured: boolean;
  enabled: boolean;
  settings: Record<string, unknown>;
  keyCount: number;
  defaultModel?: string | null;
  updatedAt: number | null;
}

export interface CatalogProvider {
  provider: string;
  name: string;
  mode: string;
  needsKey: boolean;
  defaultModel: string | null;
}

export interface ProviderTestDetails {
  provider: string;
  method?: string;
  endpoint?: string;
  keyHint?: string;
  authHeader?: string;
  requestSnippet?: string;
  responseStatus?: number;
  responseSnippet?: string;
  latencyMs?: number;
  modelCount?: number;
  error?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  modelCount?: number | null;
  details?: ProviderTestDetails | null;
}

export interface MemberView {
  id: string;
  userId: string;
  role: string;
  createdAt: number;
  name: string;
  email: string;
  image: string | null;
  self: boolean;
}

export interface InvitationView {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: number;
  inviterId: string;
  createdAt: number;
  expired: boolean;
}

export interface CostDay {
  /** Unix timestamp (seconds) at UTC midnight for the day. */
  day: number;
  cost_usd: number | null;
}

export interface UsageSummary {
  totalCostUsd: number | null;
  totalTokens?: number | null;
  requestCount?: number | null;
  [key: string]: unknown;
}

export interface AlertsView {
  daily: { limit: number | null; spent: number; ratio: number };
  monthly: { limit: number | null; spent: number; ratio: number };
  thresholdReached: string | null;
}

export interface LatencyStat {
  provider: string;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
}

/** Streaming speed for one provider + model (GET /api/metrics/speed). */
export interface SpeedStat {
  provider: string;
  model: string;
  /** Successful streamed requests with a measured first output. */
  requests: number;
  ttftP50: number;
  ttftP95: number;
  /** Output tokens/s after the first token. */
  decodeTpsP50: number | null;
  decodeTpsP95: number | null;
  /** Uncached input tokens / TTFT (includes queue and network time). */
  prefillTpsP50: number | null;
}

/** Prompt-cache usage for one provider + model (GET /api/metrics/cache). */
export interface CacheUsageRow {
  provider: string;
  model: string;
  requests: number;
  /** Uncached input tokens only — cache read/write reported separately. */
  tokensInput: number;
  /** Provider prompt-cache hits, in tokens served from the cache. */
  tokensCacheRead: number;
  /** Provider prompt-cache writes (cache creation input tokens). */
  tokensCacheWrite: number;
  /** Requests with at least one prompt-cache hit. */
  promptCacheHits: number;
  promptCacheHitRate: number;
  /** Requests served from the proxy's own response cache. */
  responseCacheHits: number;
}

/** Usage totals for one API key (GET /api/metrics/keys). */
export interface KeyUsage {
  /** Null for traffic without a key (dashboard sessions). */
  apiKeyId: string | null;
  /** Null when the key was deleted or the row has no key. */
  name: string | null;
  keyPrefix: string | null;
  status: string | null;
  requests: number;
  errors: number;
  /** Uncached input tokens; cache reads are separate. */
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  costUsd: number;
  latencyAvgMs: number;
  /** Unix seconds of the newest request in the window. */
  lastRequestAt: number;
}

export interface RequestRow {
  id: string;
  api_key_id: string | null;
  timestamp: number;
  provider: string;
  model: string;
  method: string;
  status_code: number;
  latency_ms: number;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cached: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
  cost_usd: number | null;
  error_message: string | null;
  cache_hit: number | null;
  /** Streamed requests only: time to first output, then decode duration. */
  ttft_ms?: number | null;
  decode_ms?: number | null;
}

// [fork] W11: GET /api/live snapshot (mirrors src/live/snapshot.ts).
export interface InferenceSnapshot {
  binding: string;
  sampledAt: number;
  version: string | null;
  slots: number | null;
  inFlight: number | null;
  queued: number | null;
  longestWaitS: number | null;
  kvUsageRatio: number | null;
  kvPoolPositions: number | null;
  kvReservedTokens: number | null;
  predictedTokensTotal: number | null;
  promptTokensTotal: number | null;
  cacheHitsTotal: number | null;
  cacheMissesTotal: number | null;
  cacheTokensSavedTotal: number | null;
  draftTokensTotal: number | null;
  draftAcceptedTotal: number | null;
}

export interface HostSnapshot {
  binding: string;
  sampledAt: number;
  cpuIdleSecondsTotal: number | null;
  cpuSecondsTotal: number | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  memMappedBytes: number | null;
  gpuBusyPercent: number | null;
  gpuMemUsedBytes: number | null;
  gpuMemTotalBytes: number | null;
  cpuTempC: number | null;
  gpuTempC: number | null;
  ssdTempC: number | null;
  gpuPowerW: number | null;
}

export interface LiveSnapshot {
  at: number;
  inference: InferenceSnapshot | null;
  host: HostSnapshot | null;
  lastRequest: RequestRow | null;
  /** Request throughput of the last 10 minutes, one point per 10 s (idle = 0). */
  throughput: ThroughputPoint[];
}

export interface ThroughputPoint {
  ts: number;
  decodeTps: number;
  prefillTps: number;
}

// [fork] W12: stored box history (mirrors src/live/sample-query.ts).
export interface InferenceAvg {
  slots: number | null;
  version: string | null;
  in_flight: number | null;
  queued: number | null;
  longest_wait_s: number | null;
  kv_usage_ratio: number | null;
  kv_reserved_tokens: number | null;
  cache_hit_ratio: number | null;
  cache_saved_tps: number | null;
  draft_accept_ratio: number | null;
}

export interface HostAvg {
  cpu_busy_pct: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  /** Null for rows stored before migration 0007. */
  mem_in_use_bytes: number | null;
  gpu_busy_pct: number | null;
  gpu_mem_used_bytes: number | null;
  gpu_mem_total_bytes: number | null;
  cpu_temp_c: number | null;
  gpu_temp_c: number | null;
  ssd_temp_c: number | null;
  gpu_power_w: number | null;
}

export interface SeriesPoint<T> {
  ts: number;
  ok: 0 | 1;
  /** Raw rows ok in the bucket (10-minute rows only). */
  samples: number | null;
  avg: T;
  /** `*_max` columns without the suffix; empty for raw 10 s rows. */
  max: Partial<T>;
}

export interface ThroughputSeriesPoint {
  ts: number;
  decodeTps: number;
  prefillTps: number;
  decodeTpsMax: number | null;
  prefillTpsMax: number | null;
}

export interface Series<T> {
  binding: string;
  points: SeriesPoint<T>[];
}

export interface LiveHistory {
  from: number;
  to: number;
  bucketS: number;
  inference: Series<InferenceAvg> | null;
  host: Series<HostAvg> | null;
  throughput: ThroughputSeriesPoint[];
}

export interface SampleAt {
  /** The inference binding of the request's provider. */
  binding: string;
  /** Timestamp of the stored row that was picked. */
  ts: number;
  resolutionS: 10 | 600;
  inference: InferenceAvg | null;
  host: HostAvg | null;
}

/** A request row plus its key and user (GET /api/metrics/requests/:id). */
export interface RequestDetail extends RequestRow {
  user_id: string | null;
  /** Null when the row has no key or the key was deleted. */
  key_name: string | null;
  key_prefix: string | null;
  key_status: string | null;
  /** Null for API-key traffic or a deleted user. */
  user_name: string | null;
  user_email: string | null;
}

/** Requests per provider + model (GET /api/metrics/requests/facets). */
export interface RequestFacet {
  provider: string;
  model: string;
  requests: number;
}

/** One page of the request log (GET /api/metrics/requests). */
export interface RequestPage {
  requests: RequestRow[];
  total: number;
  limit: number;
  offset: number;
}

/** One time bucket of a key's traffic. */
export interface KeySeriesPoint {
  /** Bucket start, unix seconds (UTC hour or day). */
  t: number;
  requests: number;
  errors: number;
  costUsd: number;
}

/** Requests and cost per provider + model for one key. */
export interface KeyModelUsage {
  provider: string;
  model: string;
  requests: number;
  errors: number;
  costUsd: number;
}

/** One key's usage over a window (GET /api/metrics/keys/:id). */
export interface KeyDetailUsage {
  start: number;
  end: number;
  bucketSeconds: number;
  summary: {
    requests: number;
    errors: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    costUsd: number;
    latencyAvgMs: number | null;
    lastRequestAt: number | null;
  };
  series: KeySeriesPoint[];
  models: KeyModelUsage[];
  /** All-time spend, the figure the spend cap is checked against. */
  lifetimeCostUsd: number;
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (body &&
      typeof (body as { error?: { message?: string } }).error === "object"
        ? (body as { error: { message?: string } }).error?.message
        : (body as { error?: string })?.error) ||
      `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { credentials: "include" }));
}

export async function apiSend<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return parse<T>(res);
}

/** GET /api/live/history: stored box history for [from, to) in unix seconds. */
export function liveHistory(from: number, to: number): Promise<LiveHistory> {
  return apiGet<LiveHistory>(`/api/live/history?from=${from}&to=${to}`);
}

/** GET /api/live/at: the box state around one request, or null if none stored. */
export async function liveAt(requestId: string): Promise<SampleAt | null> {
  const body = await apiGet<{ sample: SampleAt | null }>(
    `/api/live/at?request=${encodeURIComponent(requestId)}`,
  );
  return body.sample;
}
