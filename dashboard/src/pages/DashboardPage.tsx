import {
  Badge,
  Card,
  EmptyState,
  Spinner,
  StatCard,
} from "../components/ui";
import { apiGet } from "../lib/api";
import { fmtCount, fmtDay, fmtUsd, fmtTokens } from "../lib/format";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const now = Math.floor(Date.now() / 1000);
const start = now - 30 * 86400;

export function DashboardPage() {
  const costs = useQuery({
    queryKey: ["costs"],
    queryFn: () =>
      apiGet<{
        days: { day: number; cost_usd: number | null }[];
        summary: {
          costUsd: number | null;
          tokensInput: number | null;
          tokensOutput: number | null;
          requests: number;
          /** Prompt-cache read/write tokens (0 for providers without caching). */
          tokensCacheRead?: number | null;
          tokensCacheWrite?: number | null;
          /** Requests served from the proxy's own response cache. */
          responseCacheHits?: number | null;
          /** Requests with at least one provider prompt-cache hit + share. */
          promptCacheHits?: number | null;
          promptCacheHitRate?: number | null;
        };
      }>(`/api/usage/costs?start=${start}&end=${now}`),
  });
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: () =>
      apiGet<{
        daily: {
          usageUsd: number;
          limitUsd: number;
          percent: number;
          breached: boolean;
          warning: boolean;
        } | null;
        monthly: {
          usageUsd: number;
          limitUsd: number;
          percent: number;
          breached: boolean;
          warning: boolean;
        } | null;
      }>("/api/usage/alerts"),
  });

  if (costs.isLoading || alerts.isLoading)
    return <Spinner label="Loading usage…" />;
  if (costs.error || alerts.error)
    return (
      <EmptyState
        title="Could not load usage"
        description={(costs.error || alerts.error)?.message}
      />
    );

  const days = (costs.data?.days ?? []).map((d) => ({
    day: fmtDay(d.day),
    cost: d.cost_usd ?? 0,
  }));
  const summary = costs.data?.summary ?? {
    costUsd: null,
    tokensInput: null,
    tokensOutput: null,
    requests: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    responseCacheHits: 0,
    promptCacheHits: 0,
    promptCacheHitRate: 0,
  };
  const totalTokens = (summary.tokensInput ?? 0) + (summary.tokensOutput ?? 0);
  const totalCost = summary.costUsd;
  // Prompt-cache reads are billed at a fraction of the normal input rate, so
  // they're shown as their own metric rather than folded into "Total tokens".
  const cacheReadTokens = summary.tokensCacheRead ?? 0;
  const cacheWriteTokens = summary.tokensCacheWrite ?? 0;
  const responseCacheHits = summary.responseCacheHits ?? 0;
  const promptCacheHitRate = summary.promptCacheHitRate ?? 0;
  const hasCacheData =
    cacheReadTokens > 0 ||
    cacheWriteTokens > 0 ||
    responseCacheHits > 0 ||
    (summary.promptCacheHits ?? 0) > 0;

  const alertMsg = (() => {
    for (const [label, check] of [
      ["Daily", alerts.data?.daily],
      ["Monthly", alerts.data?.monthly],
    ] as const) {
      if (check?.breached)
        return `${label} spend limit reached (${check.percent}% of $${check.limitUsd}). Traffic is being limited.`;
      if (check?.warning)
        return `${label} spend is at ${check.percent}% of the $${check.limitUsd} limit.`;
    }
    return null;
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500">
          Usage and spend for the last 30 days.
        </p>
      </div>

      {alertMsg && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Spend alert</p>
            <p className="text-xs">{alertMsg}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total spend (30d)" value={fmtUsd(totalCost)} />
        <StatCard
          label="Total tokens"
          value={fmtTokens(totalTokens)}
          hint={
            hasCacheData
              ? `${fmtTokens(cacheReadTokens)} cached reads · ${fmtTokens(cacheWriteTokens)} writes`
              : undefined
          }
        />
        <StatCard
          label="Requests"
          value={fmtCount(summary.requests)}
          hint={
            responseCacheHits > 0
              ? `${fmtCount(responseCacheHits)} response-cache hits`
              : undefined
          }
        />
      </div>

      {hasCacheData && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card title="Prompt cache" subtitle="Provider-side prompt caching">
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-2xl font-semibold text-gray-900">
                  {(promptCacheHitRate * 100).toFixed(1)}%
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  hit rate · {fmtTokens(cacheReadTokens)} read /{" "}
                  {fmtTokens(cacheWriteTokens)} written
                </p>
              </div>
              <Badge tone="indigo">cached input is billed cheaper</Badge>
            </div>
          </Card>
          <Card
            title="Response cache"
            subtitle="Proxy-level duplicate-request hits"
          >
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-2xl font-semibold text-gray-900">
                  {fmtCount(responseCacheHits)}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  requests served without an upstream call
                </p>
              </div>
              <Badge tone={responseCacheHits > 0 ? "green" : "gray"}>
                {summary.requests
                  ? `${((responseCacheHits / summary.requests) * 100).toFixed(1)}% of traffic`
                  : "—"}
              </Badge>
            </div>
          </Card>
        </div>
      )}

      <Card title="Daily cost" subtitle="USD per day">
        {days.length === 0 ? (
          <EmptyState
            title="No usage yet"
            description="Once traffic flows through the proxy, costs show up here."
          />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart
              data={days}
              margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => fmtUsd(Number(v))} />
              <Line
                type="monotone"
                dataKey="cost"
                stroke="#4f46e5"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
}
