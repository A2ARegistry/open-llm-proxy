/** Request-log explorer state, kept in the URL so views can be shared. */

export const RANGE_PRESETS = [
  { value: "1h", label: "Last hour", seconds: 3600 },
  { value: "24h", label: "Last 24 hours", seconds: 24 * 3600 },
  { value: "7d", label: "Last 7 days", seconds: 7 * 24 * 3600 },
  { value: "30d", label: "Last 30 days", seconds: 30 * 24 * 3600 },
  { value: "90d", label: "Last 90 days", seconds: 90 * 24 * 3600 },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["value"];

export const STATUS_OPTIONS = [
  { value: "success", label: "Success (< 400)" },
  { value: "error", label: "Any error (≥ 400)" },
  { value: "client_error", label: "Client error (4xx)" },
  { value: "server_error", label: "Server error (5xx)" },
] as const;

export const CACHE_OPTIONS = [
  { value: "response", label: "Response cache (instant)" },
  { value: "prompt_read", label: "Prompt cache read" },
  { value: "prompt_write", label: "Prompt cache write" },
  { value: "none", label: "No cache" },
] as const;

/** `apiKeyId` filter value for traffic without a key. */
export const NO_API_KEY = "none";

export const PAGE_SIZES = [25, 50, 100, 200] as const;
const DEFAULT_RANGE: RangePreset = "24h";
const DEFAULT_PAGE_SIZE = 50;

/** Filter fields that map 1:1 to /api/metrics/requests query params. */
export const FILTER_KEYS = [
  "provider",
  "model",
  "apiKeyId",
  "status",
  "cache",
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export interface ExplorerState {
  range: RangePreset;
  filters: Partial<Record<FilterKey, string>>;
  page: number;
  pageSize: number;
  /** Request id open in the detail drawer. */
  requestId: string | null;
}

function oneOf<T extends string | number>(
  values: readonly T[],
  raw: T | null,
  fallback: T,
): T {
  return raw !== null && values.includes(raw) ? raw : fallback;
}

export function parseExplorerState(params: URLSearchParams): ExplorerState {
  const filters: Partial<Record<FilterKey, string>> = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  const page = Math.floor(Number(params.get("page")));
  return {
    range: oneOf(
      RANGE_PRESETS.map((r) => r.value),
      params.get("range") as RangePreset | null,
      DEFAULT_RANGE,
    ),
    filters,
    page: Number.isFinite(page) && page > 1 ? page : 1,
    pageSize: oneOf<number>(
      PAGE_SIZES,
      Number(params.get("size")) || null,
      DEFAULT_PAGE_SIZE,
    ),
    requestId: params.get("request") || null,
  };
}

/** URL params for a state; defaults are left out to keep links short. */
export function explorerParams(state: ExplorerState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.range !== DEFAULT_RANGE) params.set("range", state.range);
  for (const key of FILTER_KEYS) {
    const value = state.filters[key];
    if (value) params.set(key, value);
  }
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE)
    params.set("size", String(state.pageSize));
  if (state.requestId) params.set("request", state.requestId);
  return params;
}

/** [start, end) in unix seconds for a preset, ending at `nowMs`. */
export function rangeWindow(
  range: RangePreset,
  nowMs: number,
): { start: number; end: number } {
  const preset = RANGE_PRESETS.find((r) => r.value === range)!;
  const end = Math.floor(nowMs / 1000) + 1;
  return { start: end - preset.seconds, end };
}

/** Query string for GET /api/metrics/requests. */
export function requestsQuery(
  state: ExplorerState,
  window: { start: number; end: number },
): string {
  const params = new URLSearchParams({
    start: String(window.start),
    end: String(window.end),
    limit: String(state.pageSize),
    offset: String((state.page - 1) * state.pageSize),
  });
  for (const key of FILTER_KEYS) {
    const value = state.filters[key];
    if (value) params.set(key, value);
  }
  return params.toString();
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
