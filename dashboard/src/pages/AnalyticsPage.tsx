import { RequestCacheBadge } from "../components/RequestCacheBadge";
import { RequestStatusBadge } from "../components/RequestStatusBadge";
import { TimeRangeControl } from "../components/TimeRangeControl";
import {
  Badge,
  Card,
  EmptyState,
  Spinner,
  StatCard,
  Tooltip,
} from "../components/ui";
import { apiGet } from "../lib/api";
import {
  CacheUsageRow,
  KeyUsage,
  LatencyStat,
  RequestRow,
  SpeedStat,
} from "../lib/api";
import {
  fmtCount,
  fmtDateTime,
  fmtMs,
  fmtTokens,
  fmtTps,
  fmtUsd,
  fmtUsdPrecise,
  keyLabel,
  pct,
  rowDecodeTps,
} from "../lib/format";
import { NO_API_KEY } from "../lib/requestExplorer";
import { ALL_RANGES } from "../lib/timeRange";
import { useTimeRange } from "../lib/useTimeRange";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

export function AnalyticsPage() {
  const navigate = useNavigate();
  const time = useTimeRange(ALL_RANGES, "24h");
  const windowQuery = `start=${time.start}&end=${time.end}`;
  const rangeParam = `range=${time.range}`;
  const openKey = (apiKeyId: string | null) =>
    navigate(
      apiKeyId
        ? `/api-keys/${encodeURIComponent(apiKeyId)}?${rangeParam}`
        : `/requests?apiKeyId=${NO_API_KEY}&${rangeParam}`,
    );
  const openRequest = (id: string) =>
    navigate(`/requests?${rangeParam}&request=${encodeURIComponent(id)}`);
  const summary = useQuery({
    queryKey: ["analytics-summary", windowQuery],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiGet<{
        summary: {
          requests: number;
          costUsd: number | null;
          tokensInput: number | null;
          tokensOutput: number | null;
          errors: number;
          /** Prompt-cache read/write tokens (0 for providers without caching). */
          tokensCacheRead?: number | null;
          tokensCacheWrite?: number | null;
          responseCacheHits?: number | null;
          promptCacheHitRate?: number | null;
        };
      }>(`/api/metrics/summary?${windowQuery}`),
  });
  const latency = useQuery({
    queryKey: ["analytics-latency", windowQuery],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiGet<{ latency: LatencyStat[] }>(`/api/metrics/latency?${windowQuery}`),
  });
  const speed = useQuery({
    queryKey: ["analytics-speed", windowQuery],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiGet<{ speed: SpeedStat[] }>(`/api/metrics/speed?${windowQuery}`),
  });
  const cache = useQuery({
    queryKey: ["analytics-cache", windowQuery],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiGet<{ usage: CacheUsageRow[] }>(`/api/metrics/cache?${windowQuery}`),
  });
  const keys = useQuery({
    queryKey: ["analytics-keys", windowQuery],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiGet<{ keys: KeyUsage[] }>(`/api/metrics/keys?${windowQuery}`),
  });
  const requests = useQuery({
    queryKey: ["analytics-requests", windowQuery],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiGet<{ requests: RequestRow[] }>(
        `/api/metrics/requests?${windowQuery}&limit=25`,
      ),
  });

  if (summary.isLoading || latency.isLoading || requests.isLoading) {
    return <Spinner label="Loading analytics…" />;
  }
  if (summary.error || latency.error || requests.error) {
    return (
      <EmptyState
        title="Could not load analytics"
        description={
          (summary.error || latency.error || requests.error)?.message
        }
      />
    );
  }

  const s = summary.data!.summary;
  const errorCount = (s.errors as number) ?? 0;
  const requestCount = (s.requests as number) ?? 0;
  // Cached input is billed at a fraction of the normal rate, so it's excluded
  // from "Tokens" and shown separately below.
  const tokens = (s.tokensInput ?? 0) + (s.tokensOutput ?? 0);
  const cacheRows = cache.data?.usage ?? [];
  const speedRows = speed.data?.speed ?? [];
  const keyRows = keys.data?.keys ?? [];
  const keyNames = new Map(
    keyRows.map((k) => [k.apiKeyId, keyLabel(k.apiKeyId, k.name)]),
  );
  const totalCacheRead = s.tokensCacheRead ?? 0;
  const totalCacheWrite = s.tokensCacheWrite ?? 0;
  const totalResponseHits = s.responseCacheHits ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500">
            {time.option.label} across all providers and models.
          </p>
        </div>
        <TimeRangeControl
          time={time}
          allowed={ALL_RANGES}
          refreshing={summary.isFetching}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Requests" value={fmtCount(requestCount)} />
        <StatCard label="Tokens" value={fmtTokens(tokens)} />
        <StatCard label="Spend" value={fmtUsd((s.costUsd as number) ?? null)} />
        <StatCard
          label="Errors"
          value={fmtCount(errorCount)}
          tone={errorCount > 0 ? "red" : "default"}
          hint={
            requestCount
              ? `${((errorCount / requestCount) * 100).toFixed(1)}% rate`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard
          label="Cache reads"
          value={fmtTokens(totalCacheRead)}
          tone={totalCacheRead > 0 ? "green" : "default"}
          hint="prompt tokens served from provider cache"
        />
        <StatCard
          label="Cache writes"
          value={fmtTokens(totalCacheWrite)}
          hint="prompt tokens written to provider cache"
        />
        <StatCard
          label="Prompt hit rate"
          value={
            requestCount
              ? `${(((s.promptCacheHitRate ?? 0) as number) * 100).toFixed(1)}%`
              : "—"
          }
          hint="requests with ≥1 cached input chunk"
        />
        <StatCard
          label="Response cache hits"
          value={fmtCount(totalResponseHits)}
          tone={totalResponseHits > 0 ? "green" : "default"}
          hint="served by the proxy, no upstream call"
        />
      </div>

      <Card
        title="Usage by API key"
        subtitle="Requests, tokens and errors per key. Input excludes cached prompt tokens."
      >
        {keyRows.length === 0 ? (
          <EmptyState title="No key usage yet" />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Key</th>
                  <th className="px-5 py-3 font-medium">Requests</th>
                  <th className="px-5 py-3 font-medium">Errors</th>
                  <th className="px-5 py-3 text-right font-medium">Input</th>
                  <th className="px-5 py-3 text-right font-medium">
                    Cached Read
                  </th>
                  <th className="px-5 py-3 text-right font-medium">Output</th>
                  <th className="px-5 py-3 text-right font-medium">Cost</th>
                  <th className="px-5 py-3 font-medium">Avg latency</th>
                  <th className="px-5 py-3 font-medium">Last request</th>
                </tr>
              </thead>
              <tbody>
                {keyRows.map((k) => {
                  const last = fmtDateTime(k.lastRequestAt);
                  return (
                    <tr
                      key={k.apiKeyId ?? "none"}
                      tabIndex={0}
                      title={
                        k.apiKeyId
                          ? "Open key details"
                          : "Show keyless requests"
                      }
                      onClick={() => openKey(k.apiKeyId)}
                      onKeyDown={(e) =>
                        e.key === "Enter" && openKey(k.apiKeyId)
                      }
                      className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <span className="font-medium">
                            {keyLabel(k.apiKeyId, k.name)}
                          </span>
                          {k.keyPrefix && (
                            <span className="font-mono text-[11px] text-gray-400">
                              {k.keyPrefix}…
                            </span>
                          )}
                          {k.status === "revoked" && (
                            <Badge tone="amber">revoked</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3">{fmtCount(k.requests)}</td>
                      <td className="px-5 py-3">
                        {k.errors > 0 ? (
                          <Badge tone="red">{fmtCount(k.errors)}</Badge>
                        ) : (
                          <span className="text-gray-400">0</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {fmtTokens(k.tokensInput)}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {fmtTokens(k.tokensCacheRead)}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {fmtTokens(k.tokensOutput)}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-700">
                        {fmtUsd(k.costUsd)}
                      </td>
                      <td className="px-5 py-3">{fmtMs(k.latencyAvgMs)}</td>
                      <td className="px-5 py-3 whitespace-nowrap text-gray-600">
                        {last.full}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Latency by provider"
        subtitle="p50 / p95 / p99 (successful requests)"
      >
        {(latency.data?.latency ?? []).length === 0 ? (
          <EmptyState title="No latency data yet" />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Requests</th>
                  <th className="px-5 py-3 font-medium">p50</th>
                  <th className="px-5 py-3 font-medium">p95</th>
                  <th className="px-5 py-3 font-medium">p99</th>
                  <th className="px-5 py-3 font-medium">Avg</th>
                </tr>
              </thead>
              <tbody>
                {latency.data!.latency.map((l) => (
                  <tr
                    key={l.provider}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="px-5 py-3 font-medium">{l.provider}</td>
                    <td className="px-5 py-3">{fmtCount(l.requests)}</td>
                    <td className="px-5 py-3">{fmtMs(l.p50)}</td>
                    <td className="px-5 py-3">{fmtMs(l.p95)}</td>
                    <td className="px-5 py-3">{fmtMs(l.p99)}</td>
                    <td className="px-5 py-3">{fmtMs(l.avg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Speed by model"
        subtitle="Streamed requests only. TTFT includes queue, prefill and network; prefill rate is uncached input ÷ TTFT."
      >
        {speedRows.length === 0 ? (
          <EmptyState
            title="No speed data yet"
            description="Speed metrics appear once streamed requests flow through the proxy."
          />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Streams</th>
                  <th className="px-5 py-3 font-medium">TTFT p50</th>
                  <th className="px-5 py-3 font-medium">TTFT p95</th>
                  <th className="px-5 py-3 text-right font-medium">
                    Decode p50
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Decode p95
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Prefill p50
                  </th>
                </tr>
              </thead>
              <tbody>
                {speedRows.map((row) => (
                  <tr
                    key={`${row.provider}:${row.model}`}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="px-5 py-3 font-medium">{row.provider}</td>
                    <td className="px-5 py-3 text-gray-600">{row.model}</td>
                    <td className="px-5 py-3">{fmtCount(row.requests)}</td>
                    <td className="px-5 py-3">{fmtMs(row.ttftP50)}</td>
                    <td className="px-5 py-3">{fmtMs(row.ttftP95)}</td>
                    <td className="px-5 py-3 text-right font-medium">
                      {fmtTps(row.decodeTpsP50)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTps(row.decodeTpsP95)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTps(row.prefillTpsP50)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Cache efficiency by model"
        subtitle="Prompt cache savings (reused context) and proxy duplicate-request hits"
      >
        {cacheRows.length === 0 ? (
          <EmptyState
            title="No cache data yet"
            description="Cache metrics appear once traffic flows through the proxy."
          />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Requests</th>
                  <th className="px-5 py-3 font-medium">Hit rate</th>
                  <th className="px-5 py-3 text-right font-medium">
                    Uncached Input
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Cached Read
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Cache Write
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Proxy Hits
                  </th>
                </tr>
              </thead>
              <tbody>
                {cacheRows.map((row) => (
                  <tr
                    key={`${row.provider}:${row.model}`}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="px-5 py-3 font-medium">{row.provider}</td>
                    <td className="px-5 py-3 text-gray-600">{row.model}</td>
                    <td className="px-5 py-3">{fmtCount(row.requests)}</td>
                    <td className="px-5 py-3">
                      {row.promptCacheHits > 0 ? (
                        <Tooltip
                          content={`${fmtCount(row.promptCacheHits)} of ${fmtCount(row.requests)} requests had prompt cache hits`}
                        >
                          <Badge tone="green">
                            {pct(row.promptCacheHitRate)} hit
                          </Badge>
                        </Tooltip>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTokens(row.tokensInput)}
                    </td>
                    <td className="px-5 py-3 text-right font-medium text-emerald-700">
                      {fmtTokens(row.tokensCacheRead)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTokens(row.tokensCacheWrite)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {row.responseCacheHits > 0 ? (
                        <Badge tone="green">
                          {fmtCount(row.responseCacheHits)}
                        </Badge>
                      ) : (
                        "0"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Recent requests"
        subtitle="Latest 25. Click a row for details."
        actions={
          <Link
            to={`/requests?${rangeParam}`}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            View all →
          </Link>
        }
      >
        {(requests.data?.requests ?? []).length === 0 ? (
          <EmptyState title="No requests in this time range" />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Time</th>
                  <th className="px-5 py-3 font-medium">Key</th>
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
                {requests.data!.requests.map((r) => {
                  const dt = fmtDateTime(r.timestamp);
                  return (
                    <tr
                      key={r.id}
                      tabIndex={0}
                      onClick={() => openRequest(r.id)}
                      onKeyDown={(e) => e.key === "Enter" && openRequest(r.id)}
                      className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                    >
                      <td className="px-5 py-3 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="font-medium text-gray-800">
                            {dt.time}
                          </span>
                          <span className="text-[11px] text-gray-400 font-normal">
                            {dt.date}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-gray-600">
                        {keyNames.get(r.api_key_id) ??
                          keyLabel(r.api_key_id, null)}
                      </td>
                      <td className="px-5 py-3 font-medium">{r.provider}</td>
                      <td className="px-5 py-3 text-gray-600">
                        {r.model || "—"}
                      </td>
                      <td className="px-5 py-3">
                        <RequestStatusBadge
                          status={r.status_code}
                          error={r.error_message}
                        />
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
                      <td
                        className="px-5 py-3 text-right text-gray-700"
                        title={
                          r.cost_usd
                            ? `$${Number(r.cost_usd.toPrecision(6))}`
                            : undefined
                        }
                      >
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
    </div>
  );
}
