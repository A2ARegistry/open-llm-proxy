import { Badge, Card, EmptyState, Spinner, StatCard } from "../components/ui";
import { apiGet } from "../lib/api";
import { CacheUsageRow, LatencyStat, RequestRow } from "../lib/api";
import { fmtDay, fmtMs, fmtTokens, fmtUsd, pct } from "../lib/format";
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
        <StatCard label="Requests" value={requestCount.toLocaleString()} />
        <StatCard label="Tokens" value={fmtTokens(tokens)} />
        <StatCard label="Spend" value={fmtUsd((s.costUsd as number) ?? null)} />
        <StatCard
          label="Errors"
          value={errorCount.toLocaleString()}
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
          value={totalResponseHits.toLocaleString()}
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
                    <td className="px-5 py-3">{l.requests.toLocaleString()}</td>
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
        subtitle="Provider prompt-cache reads/writes and proxy response-cache hits"
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
                    Input (uncached)
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Cache read
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Cache write
                  </th>
                  <th className="px-5 py-3 text-right font-medium">
                    Resp. hits
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
                      {row.requests.toLocaleString()}
                    </td>
                    <td className="px-5 py-3">
                      {row.promptCacheHits > 0 ? (
                        <Badge tone="green">{pct(row.promptCacheHitRate)}</Badge>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTokens(row.tokensInput)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTokens(row.tokensCacheRead)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTokens(row.tokensCacheWrite)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {row.responseCacheHits.toLocaleString()}
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
                {requests.data!.requests.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="px-5 py-3 text-gray-500">
                      {fmtDay(r.timestamp)}
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
                        <Badge tone="green" title="Served from proxy response cache — no upstream call">
                          response hit
                        </Badge>
                      ) : (r.tokens_cache_read ?? 0) > 0 ? (
                        <Badge
                          tone="blue"
                          title={`${fmtTokens(r.tokens_cache_read)} input tokens served from the provider prompt cache`}
                        >
                          prompt · {fmtTokens(r.tokens_cache_read)}
                        </Badge>
                      ) : (r.tokens_cache_write ?? 0) > 0 ? (
                        <Badge
                          tone="amber"
                          title={`${fmtTokens(r.tokens_cache_write)} input tokens written to the provider prompt cache`}
                        >
                          write · {fmtTokens(r.tokens_cache_write)}
                        </Badge>
                      ) : (
                        <span className="text-gray-300">—</span>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
