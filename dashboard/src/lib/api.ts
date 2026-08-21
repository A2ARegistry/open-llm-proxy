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
  day: string;
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
  cost_usd: number | null;
  error_message: string | null;
  cache_hit: number | null;
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
