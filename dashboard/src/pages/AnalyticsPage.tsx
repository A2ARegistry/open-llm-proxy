import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
import { fmtDay, fmtMs, fmtTokens, fmtUsd } from "../lib/format";
import {
  Badge,
  Card,
  EmptyState,
  Spinner,
  StatCard,
} from "../components/ui";
import { LatencyStat, RequestRow } from "../lib/api";

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
  const requests = useQuery({
    queryKey: ["analytics-requests"],
    queryFn: () =>
      apiGet<{ requests: RequestRow[] }>(
        `/api/metrics/requests?start=${dayStart}&end=${now}&limit=25`,
      ),
  });

  if (summary.isLoading || latency.isLoading || requests.isLoading) {
    return <Spinner label="Loading analytics…" />;
  }
  if (summary.error || latency.error || requests.error) {
    return (
      <EmptyState
        title="Could not load analytics"
        description={(summary.error || latency.error || requests.error)?.message}
      />
    );
  }

  const s = summary.data!.summary;
  const errorCount = (s.errors as number) ?? 0;
  const requestCount = (s.requests as number) ?? 0;
  const tokens = (s.tokensInput ?? 0) + (s.tokensOutput ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Analytics</h1>
        <p className="text-sm text-gray-500">Last 24 hours across all providers and models.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Requests" value={requestCount.toLocaleString()} />
        <StatCard label="Tokens" value={fmtTokens(tokens)} />
        <StatCard label="Spend" value={fmtUsd((s.costUsd as number) ?? null)} />
        <StatCard
          label="Errors"
          value={errorCount.toLocaleString()}
          tone={errorCount > 0 ? "red" : "default"}
          hint={requestCount ? `${((errorCount / requestCount) * 100).toFixed(1)}% rate` : undefined}
        />
      </div>

      <Card title="Latency by provider" subtitle="p50 / p95 / p99 (successful requests)">
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
                  <tr key={l.provider} className="border-b border-gray-50 last:border-0">
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
                  <th className="px-5 py-3 font-medium">Latency</th>
                  <th className="px-5 py-3 text-right font-medium">Tokens (in/out)</th>
                  <th className="px-5 py-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {requests.data!.requests.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-5 py-3 text-gray-500">{fmtDay(r.timestamp)}</td>
                    <td className="px-5 py-3 font-medium">{r.provider}</td>
                    <td className="px-5 py-3 text-gray-600">{r.model || "—"}</td>
                    <td className="px-5 py-3">
                      {r.status_code < 400 ? (
                        <Badge tone="green">{r.status_code}</Badge>
                      ) : (
                        <Badge tone="red" >
                          {r.status_code}
                        </Badge>
                      )}
                    </td>
                    <td className="px-5 py-3">{fmtMs(r.latency_ms)}</td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {r.tokens_input ?? 0} / {r.tokens_output ?? 0}
                      {r.cache_hit ? " (cached)" : ""}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700">{fmtUsd(r.cost_usd)}</td>
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