import {
  Badge,
  Card,
  EmptyState,
  Spinner,
  StatCard,
  Tooltip,
} from "../components/ui";
import { apiGet } from "../lib/api";
import { CacheUsageRow, LatencyStat, RequestRow } from "../lib/api";
import {
  fmtCount,
  fmtDateTime,
  fmtMs,
  fmtTokens,
  fmtUsd,
  pct,
} from "../lib/format";
import { useQuery } from "@tanstack/react-query";

const now = Math.floor(Date.now() / 1000);
const dayStart = now - 24 * 3600;

export function AnalyticsPage() {
  const summary = useQuery({
    queryKey: ["analytics-summary"],
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
      }>(`/api/metrics/summary?start=${dayStart}&end=${now}`),
  });
  const latency = useQuery({
    queryKey: ["analytics-latency"],
    queryFn: () =>
      apiGet<{ latency: LatencyStat[] }>(
        `/api/metrics/latency?start=${dayStart}&end=${now}`,
      ),
  });
  const cache = useQuery({
    queryKey: ["analytics-cache"],
    queryFn: () =>
      apiGet<{ usage: CacheUsageRow[] }>(
        `/api/metrics/cache?start=${dayStart}&end=${now}`,
      ),
  });
  const requests = useQuery({
    queryKey: ["analytics-requests"],
    queryFn: () =>
      apiGet<{ requests: RequestRow[] }>(
        `/api/metrics/requests?start=${dayStart}&end=${now}&limit=25`,
      ),
  });

  if (summary.isLoading || latency.isLoading || requests.isLoading) {
    return <Spinner label="Loading analytics…" />;
  }  if (summary.error || latency.error || requests.error) {
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
  const totalCacheRead = s.tokensCacheRead ?? 0;
  const totalCacheWrite = s.tokensCacheWrite ?? 0;
  const totalResponseHits = s.responseCacheHits ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-500">
          Last 24 hours across all providers and models.
        </p>
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
                    <td className="px-5 py-3">
                      {fmtCount(row.requests)}
                    </td>
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

      <Card title="Recent requests">
        {(requests.data?.requests ?? []).length === 0 ? (
          <EmptyState title="No requests in the last 24 hours" />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Time</th>
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Cache</th>
                  <th className="px-5 py-3 font-medium">Latency</th>
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
                      className="border-b border-gray-50 last:border-0"
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
                      <td className="px-5 py-3 font-medium">{r.provider}</td>
                      <td className="px-5 py-3 text-gray-600">
                        {r.model || "—"}
                      </td>
                      <td className="px-5 py-3">
                        {r.status_code < 400 ? (
                          <Badge tone="green">{r.status_code}</Badge>
                        ) : (
                          <Badge tone="red">{r.status_code}</Badge>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {r.cache_hit ? (
                          <Tooltip content="Served 100% from the proxy response cache without making an upstream LLM API call ($0 cost)">
                            <Badge tone="green">
                              <span className="font-semibold">⚡ Instant</span>
                            </Badge>
                          </Tooltip>
                        ) : (r.tokens_cache_read ?? 0) > 0 ? (
                          <Tooltip
                            content={
                              <div className="space-y-1">
                                <p className="font-semibold text-sky-300">
                                  Provider Prompt Cache Hit
                                </p>
                                <p>
                                  {fmtTokens(r.tokens_cache_read)} tokens reused from
                                  cache ({pct((r.tokens_cache_read ?? 0) / ((r.tokens_input ?? 0) + (r.tokens_cache_read ?? 0)))} of input).
                                </p>
                                <p className="text-[10px] text-gray-300">
                                  Billed at a discount vs fresh input tokens.
                                </p>
                              </div>
                            }
                          >
                            <Badge tone="blue">
                              <span>
                                {pct(
                                  (r.tokens_cache_read ?? 0) /
                                    ((r.tokens_input ?? 0) +
                                      (r.tokens_cache_read ?? 0)),
                                )}{" "}
                                cached
                              </span>
                              <span className="text-[10px] opacity-75 font-mono">
                                ({fmtTokens(r.tokens_cache_read)})
                              </span>
                            </Badge>
                          </Tooltip>
                        ) : (r.tokens_cache_write ?? 0) > 0 ? (
                          <Tooltip
                            content={
                              <div className="space-y-1">
                                <p className="font-semibold text-amber-300">
                                  Prompt Cache Creation
                                </p>
                                <p>
                                  {fmtTokens(r.tokens_cache_write)} input tokens
                                  written to the provider cache for faster future requests.
                                </p>
                              </div>
                            }
                          >
                            <Badge tone="amber">
                              <span>cache write</span>
                              <span className="text-[10px] opacity-75 font-mono">
                                ({fmtTokens(r.tokens_cache_write)})
                              </span>
                            </Badge>
                          </Tooltip>
                        ) : (
                          <span className="text-gray-300 select-none">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">{fmtMs(r.latency_ms)}</td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {r.tokens_input ?? 0} / {r.tokens_output ?? 0}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-700">
                        {fmtUsd(r.cost_usd)}
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
