/** Status filter for the request log. */
export const REQUEST_STATUSES = [
  "success",
  "error",
  "client_error",
  "server_error",
] as const;
export type RequestStatusFilter = (typeof REQUEST_STATUSES)[number];

/** Cache filter for the request log. */
export const REQUEST_CACHE_KINDS = [
  "response",
  "prompt_read",
  "prompt_write",
  "none",
] as const;
export type RequestCacheFilter = (typeof REQUEST_CACHE_KINDS)[number];

/** `apiKeyId` value that selects traffic without a key (dashboard sessions). */
export const NO_API_KEY = "none";

export interface RequestFilters {
  start: number;
  end: number;
  provider?: string;
  model?: string;
  /** A key id, or NO_API_KEY for keyless traffic. */
  apiKeyId?: string;
  status?: RequestStatusFilter;
  cache?: RequestCacheFilter;
}

/** One request_metrics row as the dashboard reads it. */
export interface RequestLogRow {
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
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  cost_usd: number | null;
  error_message: string | null;
  cache_hit: number;
  ttft_ms: number | null;
  decode_ms: number | null;
}

/** A request row plus the key and user it belongs to. */
export interface RequestDetail extends RequestLogRow {
  user_id: string | null;
  /** Null when the row has no key or the key was deleted. */
  key_name: string | null;
  key_prefix: string | null;
  key_status: string | null;
  /** Null for API-key traffic or a deleted user. */
  user_name: string | null;
  user_email: string | null;
}

/** Request count per provider + model, for filter dropdowns. */
export interface RequestFacet {
  provider: string;
  model: string;
  requests: number;
}

const ROW_COLUMNS = `m.id, m.api_key_id, m.timestamp, m.provider, m.model, m.method,
  m.status_code, m.latency_ms, m.tokens_input, m.tokens_output, m.tokens_cached,
  m.tokens_cache_read, m.tokens_cache_write, m.cost_usd, m.error_message,
  m.cache_hit, m.ttft_ms, m.decode_ms`;

const STATUS_SQL: Record<RequestStatusFilter, string> = {
  success: "m.status_code < 400",
  error: "m.status_code >= 400",
  client_error: "m.status_code >= 400 AND m.status_code < 500",
  server_error: "m.status_code >= 500",
};

const CACHE_SQL: Record<RequestCacheFilter, string> = {
  response: "m.cache_hit = 1",
  prompt_read: "m.cache_hit = 0 AND COALESCE(m.tokens_cache_read, 0) > 0",
  prompt_write:
    "m.cache_hit = 0 AND COALESCE(m.tokens_cache_read, 0) = 0 AND COALESCE(m.tokens_cache_write, 0) > 0",
  none: "m.cache_hit = 0 AND COALESCE(m.tokens_cache_read, 0) = 0 AND COALESCE(m.tokens_cache_write, 0) = 0",
};

function isOneOf<T extends string>(
  values: readonly T[],
  value: string,
): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * Reads the optional status/cache/key/model filters from a query string.
 * Returns an error message for an unknown status or cache value.
 */
export function parseRequestFilters(
  query: (key: string) => string | undefined,
): Omit<RequestFilters, "start" | "end" | "provider"> | string {
  const status = query("status") || undefined;
  const cache = query("cache") || undefined;
  if (status !== undefined && !isOneOf(REQUEST_STATUSES, status)) {
    return `status must be one of ${REQUEST_STATUSES.join(", ")}`;
  }
  if (cache !== undefined && !isOneOf(REQUEST_CACHE_KINDS, cache)) {
    return `cache must be one of ${REQUEST_CACHE_KINDS.join(", ")}`;
  }
  return {
    status,
    cache,
    apiKeyId: query("apiKeyId") || undefined,
    model: query("model") || undefined,
  };
}

function whereClause(
  organizationId: string,
  filters: RequestFilters,
): { sql: string; params: (string | number)[] } {
  const where = [
    "m.organization_id = ?",
    "m.timestamp >= ?",
    "m.timestamp < ?",
  ];
  const params: (string | number)[] = [
    organizationId,
    filters.start,
    filters.end,
  ];
  if (filters.provider) {
    where.push("m.provider = ?");
    params.push(filters.provider);
  }
  if (filters.model) {
    where.push("m.model = ?");
    params.push(filters.model);
  }
  if (filters.apiKeyId === NO_API_KEY) {
    where.push("m.api_key_id IS NULL");
  } else if (filters.apiKeyId) {
    where.push("m.api_key_id = ?");
    params.push(filters.apiKeyId);
  }
  if (filters.status) where.push(STATUS_SQL[filters.status]);
  if (filters.cache) where.push(CACHE_SQL[filters.cache]);
  return { sql: where.join(" AND "), params };
}

/**
 * Newest-first page of request rows plus the total matching count.
 * Count and page go to D1 in one batch (one round trip).
 */
export async function listRequests(
  env: Env,
  organizationId: string,
  filters: RequestFilters,
  limit: number,
  offset: number,
): Promise<{ requests: RequestLogRow[]; total: number }> {
  const { sql, params } = whereClause(organizationId, filters);
  const [count, page] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS total FROM request_metrics m WHERE ${sql}`,
    ).bind(...params),
    env.DB.prepare(
      `SELECT ${ROW_COLUMNS} FROM request_metrics m WHERE ${sql}
       ORDER BY m.timestamp DESC, m.id DESC LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset),
  ]);
  return {
    requests: page.results as unknown as RequestLogRow[],
    total: (count.results[0] as { total: number }).total,
  };
}

/**
 * [fork] W11: the org's most recent request row (null when it has none), as a
 * statement for the caller's own `DB.batch`.
 */
export function latestRequestStatement(
  env: Env,
  organizationId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM request_metrics m
     WHERE m.organization_id = ?
     ORDER BY m.timestamp DESC, m.id DESC LIMIT 1`,
  ).bind(organizationId);
}

/** One request row with its key and user, or null if not in this org. */
export async function getRequest(
  env: Env,
  organizationId: string,
  id: string,
): Promise<RequestDetail | null> {
  return env.DB.prepare(
    `SELECT ${ROW_COLUMNS}, m.user_id,
            k.name AS key_name, k.key_prefix, k.status AS key_status,
            u.name AS user_name, u.email AS user_email
     FROM request_metrics m
     LEFT JOIN api_keys k
       ON k.id = m.api_key_id AND k.organization_id = m.organization_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? AND m.id = ?`,
  )
    .bind(organizationId, id)
    .first<RequestDetail>();
}

/** Providers and models seen in [start, end), busiest first. */
export async function requestFacets(
  env: Env,
  organizationId: string,
  start: number,
  end: number,
): Promise<RequestFacet[]> {
  const { results } = await env.DB.prepare(
    `SELECT provider, model, COUNT(*) AS requests
     FROM request_metrics
     WHERE organization_id = ? AND timestamp >= ? AND timestamp < ?
     GROUP BY provider, model
     ORDER BY requests DESC, provider, model`,
  )
    .bind(organizationId, start, end)
    .all<RequestFacet>();
  return results;
}
