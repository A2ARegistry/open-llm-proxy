import { RequestCacheBadge } from "../components/RequestCacheBadge";
import { RequestDetailDrawer } from "../components/RequestDetailDrawer";
import { RequestStatusBadge } from "../components/RequestStatusBadge";
import {
  Button,
  Card,
  EmptyState,
  Label,
  Select,
  SelectOption,
  Spinner,
} from "../components/ui";
import { apiGet, ApiKeyView, RequestFacet, RequestPage } from "../lib/api";
import {
  fmtCount,
  fmtDateTime,
  fmtMs,
  fmtTps,
  fmtUsdPrecise,
  keyLabel,
  rowDecodeTps,
} from "../lib/format";
import {
  CACHE_OPTIONS,
  ExplorerState,
  explorerParams,
  FilterKey,
  NO_API_KEY,
  PAGE_SIZES,
  pageCount,
  parseExplorerState,
  requestsQuery,
  STATUS_OPTIONS,
} from "../lib/requestExplorer";
import {
  ALL_RANGES,
  RANGE_PRESETS,
  RangePreset,
  rangeWindow,
} from "../lib/timeRange";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

const ALL = "";

function withAll(label: string, options: SelectOption[]): SelectOption[] {
  return [{ value: ALL, label }, ...options];
}

export function RequestsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseExplorerState(searchParams);
  // The window is pinned until Refresh so paging doesn't shift under the user.
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const timeWindow = useMemo(
    () => rangeWindow(state.range, anchorMs),
    [state.range, anchorMs],
  );

  const update = (patch: Partial<ExplorerState>) =>
    setSearchParams(explorerParams({ ...state, ...patch }));

  const setFilter = (key: FilterKey, value: string) => {
    const filters = { ...state.filters, [key]: value || undefined };
    // A model belongs to one provider; drop it when the provider changes.
    if (key === "provider") delete filters.model;
    update({ filters, page: 1, requestId: null });
  };

  const requests = useQuery({
    queryKey: ["requests-log", requestsQuery(state, timeWindow)],
    queryFn: () =>
      apiGet<RequestPage>(
        `/api/metrics/requests?${requestsQuery(state, timeWindow)}`,
      ),
    placeholderData: keepPreviousData,
  });
  const facets = useQuery({
    queryKey: ["requests-facets", timeWindow.start, timeWindow.end],
    queryFn: () =>
      apiGet<{ facets: RequestFacet[] }>(
        `/api/metrics/requests/facets?start=${timeWindow.start}&end=${timeWindow.end}`,
      ),
  });
  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () => apiGet<{ keys: ApiKeyView[] }>("/api/keys"),
  });

  const facetRows = facets.data?.facets ?? [];
  const providerOptions = withAll(
    "All providers",
    [...new Set(facetRows.map((f) => f.provider))].map((p) => ({
      value: p,
      label: p,
    })),
  );
  const modelOptions = withAll(
    "All models",
    facetRows
      .filter(
        (f) => !state.filters.provider || f.provider === state.filters.provider,
      )
      .map((f) => ({
        value: f.model,
        label: `${f.model} (${fmtCount(f.requests)})`,
      })),
  );
  const keyNames = new Map(
    (keys.data?.keys ?? []).map((k) => [k.id, k.name] as const),
  );
  const keyOptions = withAll("All callers", [
    ...(keys.data?.keys ?? []).map((k) => ({
      value: k.id,
      label: k.status === "revoked" ? `${k.name} (revoked)` : k.name,
    })),
    { value: NO_API_KEY, label: "Dashboard (no key)" },
  ]);

  const total = requests.data?.total ?? 0;
  const pages = pageCount(total, state.pageSize);
  const rows = requests.data?.requests ?? [];
  const firstRow = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const lastRow = Math.min(state.page * state.pageSize, total);
  const hasFilters = Object.keys(state.filters).length > 0;

  const openRequest = (id: string) => update({ requestId: id });
  const closeRequest = () => update({ requestId: null });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Requests</h1>
          <p className="text-sm text-gray-500">
            Every request through the proxy. Click a row for details.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setAnchorMs(Date.now())}
          loading={requests.isFetching}
        >
          {!requests.isFetching && <RefreshCw size={14} />}
          Refresh
        </Button>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <Label>Time range</Label>
            <Select
              value={state.range}
              onChange={(v) =>
                update({ range: v as RangePreset, page: 1, requestId: null })
              }
              options={RANGE_PRESETS.filter((r) =>
                ALL_RANGES.includes(r.value),
              ).map((r) => ({
                value: r.value,
                label: r.label,
              }))}
            />
          </div>
          <div>
            <Label>Provider</Label>
            <Select
              value={state.filters.provider ?? ALL}
              onChange={(v) => setFilter("provider", v as string)}
              options={providerOptions}
            />
          </div>
          <div>
            <Label>Model</Label>
            <Select
              value={state.filters.model ?? ALL}
              onChange={(v) => setFilter("model", v as string)}
              options={modelOptions}
            />
          </div>
          <div>
            <Label>Caller</Label>
            <Select
              value={state.filters.apiKeyId ?? ALL}
              onChange={(v) => setFilter("apiKeyId", v as string)}
              options={keyOptions}
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select
              value={state.filters.status ?? ALL}
              onChange={(v) => setFilter("status", v as string)}
              options={withAll("Any status", [...STATUS_OPTIONS])}
            />
          </div>
          <div>
            <Label>Cache</Label>
            <Select
              value={state.filters.cache ?? ALL}
              onChange={(v) => setFilter("cache", v as string)}
              options={withAll("Any cache use", [...CACHE_OPTIONS])}
            />
          </div>
        </div>
        {hasFilters && (
          <div className="mt-3 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => update({ filters: {}, page: 1, requestId: null })}
            >
              Clear filters
            </Button>
          </div>
        )}
      </Card>

      <Card>
        {requests.isLoading ? (
          <Spinner label="Loading requests…" />
        ) : requests.error ? (
          <EmptyState
            title="Could not load requests"
            description={requests.error.message}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No matching requests"
            description={
              hasFilters
                ? "Try a wider time range or fewer filters."
                : "No traffic in this time range."
            }
          />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Time</th>
                  <th className="px-5 py-3 font-medium">Caller</th>
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Cache</th>
                  <th className="px-5 py-3 font-medium">Latency</th>
                  <th className="px-5 py-3 font-medium">TTFT</th>
                  <th className="px-5 py-3 text-right font-medium">Tok/s</th>
                  <th className="px-5 py-3 text-right font-medium">
                    Tokens (in/out)
                  </th>
                  <th className="px-5 py-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const dt = fmtDateTime(r.timestamp);
                  const selected = r.id === state.requestId;
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      onClick={() => openRequest(r.id)}
                      onKeyDown={(e) => e.key === "Enter" && openRequest(r.id)}
                      className={`cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50 focus:bg-indigo-50 focus:outline-none ${
                        selected ? "bg-indigo-50" : ""
                      }`}
                    >
                      <td className="whitespace-nowrap px-5 py-3">
                        <div className="flex flex-col">
                          <span className="font-medium text-gray-800">
                            {dt.time}
                          </span>
                          <span className="text-[11px] text-gray-400">
                            {dt.date}
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-gray-600">
                        {keyLabel(
                          r.api_key_id,
                          keyNames.get(r.api_key_id ?? "") ?? null,
                        )}
                      </td>
                      <td className="px-5 py-3 font-medium">{r.provider}</td>
                      <td className="px-5 py-3 text-gray-600">
                        {r.model || "—"}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <RequestStatusBadge
                            status={r.status_code}
                            error={r.error_message}
                          />
                          {r.error_message && (
                            <span className="block max-w-[16rem] truncate text-[11px] text-red-600">
                              {r.error_message}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <RequestCacheBadge row={r} />
                      </td>
                      <td className="px-5 py-3">{fmtMs(r.latency_ms)}</td>
                      <td className="px-5 py-3">{fmtMs(r.ttft_ms)}</td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {fmtTps(rowDecodeTps(r.tokens_output, r.decode_ms))}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {r.tokens_input ?? 0} / {r.tokens_output ?? 0}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-700">
                        {fmtUsdPrecise(r.cost_usd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
          <span>
            {fmtCount(firstRow)}–{fmtCount(lastRow)} of {total.toLocaleString()}{" "}
            requests
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">Rows</span>
              <Select
                className="w-20"
                value={String(state.pageSize)}
                onChange={(v) =>
                  update({ pageSize: Number(v), page: 1, requestId: null })
                }
                options={PAGE_SIZES.map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={state.page <= 1}
              onClick={() => update({ page: state.page - 1, requestId: null })}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="text-xs">
              Page {state.page} of {pages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={state.page >= pages}
              onClick={() => update({ page: state.page + 1, requestId: null })}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}

      <RequestDetailDrawer
        requestId={state.requestId}
        onClose={closeRequest}
        onFilter={(key, value) => setFilter(key, value)}
      />
    </div>
  );
}
