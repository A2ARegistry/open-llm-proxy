import { RequestStatusBadge } from "../components/RequestStatusBadge";
import { SpendCapMeter } from "../components/SpendCapMeter";
import { TimeRangeControl } from "../components/TimeRangeControl";
import { Badge, Card, EmptyState, Spinner, StatCard } from "../components/ui";
import {
  apiGet,
  ApiKeyView,
  KeyDetailUsage,
  KeySeriesPoint,
  RequestPage,
} from "../lib/api";
import {
  fmtCount,
  fmtDate,
  fmtDateTime,
  fmtDay,
  fmtMs,
  fmtTokens,
  fmtUsd,
  fmtUsdPrecise,
} from "../lib/format";
import { ALL_RANGES, fillBuckets } from "../lib/timeRange";
import { useTimeRange } from "../lib/useTimeRange";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const RECENT_LIMIT = 10;

function ScopeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 text-right text-gray-900">{children}</dd>
    </div>
  );
}

function ScopeList({ values, empty }: { values?: string[]; empty: string }) {
  if (!values?.length) return <span className="text-gray-400">{empty}</span>;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {values.map((v) => (
        <Badge key={v}>{v}</Badge>
      ))}
    </div>
  );
}

function bucketLabel(t: number, bucketSeconds: number): string {
  if (bucketSeconds >= 86400) return fmtDay(t);
  return new Date(t * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ApiKeyDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const time = useTimeRange(ALL_RANGES, "7d");
  const windowQuery = `start=${time.start}&end=${time.end}`;
  const explorerBase = `/requests?apiKeyId=${encodeURIComponent(id)}&range=${time.range}`;

  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () => apiGet<{ keys: ApiKeyView[] }>("/api/keys"),
  });
  const usage = useQuery({
    queryKey: ["key-detail", id, windowQuery],
    queryFn: () =>
      apiGet<KeyDetailUsage>(
        `/api/metrics/keys/${encodeURIComponent(id)}?${windowQuery}`,
      ),
    placeholderData: keepPreviousData,
  });
  const recent = useQuery({
    queryKey: ["key-recent", id, windowQuery],
    queryFn: () =>
      apiGet<RequestPage>(
        `/api/metrics/requests?${windowQuery}&apiKeyId=${encodeURIComponent(id)}&limit=${RECENT_LIMIT}`,
      ),
    placeholderData: keepPreviousData,
  });

  if (keys.isLoading || usage.isLoading) {
    return <Spinner label="Loading key…" />;
  }
  if (keys.error || usage.error) {
    return (
      <EmptyState
        title="Could not load key"
        description={(keys.error || usage.error)?.message}
      />
    );
  }
  const key = keys.data!.keys.find((k) => k.id === id);
  if (!key) {
    return (
      <EmptyState
        title="Key not found"
        description="It may have been deleted, or it belongs to another workspace."
        action={
          <Link
            to="/api-keys"
            className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
          >
            Back to API keys
          </Link>
        }
      />
    );
  }

  const u = usage.data!;
  const s = u.summary;
  const series = fillBuckets<KeySeriesPoint>(
    u.series,
    u.start,
    u.end,
    u.bucketSeconds,
    (t) => ({ t, requests: 0, errors: 0, costUsd: 0 }),
  ).map((p) => ({
    label: bucketLabel(p.t, u.bucketSeconds),
    ok: p.requests - p.errors,
    errors: p.errors,
    cost: p.costUsd,
  }));
  const recentRows = recent.data?.requests ?? [];
  const scopes = key.scopes;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/api-keys"
            className="mb-1 inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft size={12} /> API keys
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-gray-900">
              {key.name}
            </h1>
            <span className="font-mono text-xs text-gray-400">
              {key.keyPrefix}…
            </span>
            <Badge tone={key.status === "active" ? "green" : "red"}>
              {key.status}
            </Badge>
          </div>
          <p className="text-sm text-gray-500">
            {time.option.label} of traffic for this key.
          </p>
        </div>
        <TimeRangeControl
          time={time}
          allowed={ALL_RANGES}
          refreshing={usage.isFetching}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Requests" value={fmtCount(s.requests)} />
        <StatCard
          label="Errors"
          value={fmtCount(s.errors)}
          tone={s.errors > 0 ? "red" : "default"}
          hint={
            s.requests
              ? `${((s.errors / s.requests) * 100).toFixed(1)}% rate`
              : undefined
          }
        />
        <StatCard
          label={`Spend (${time.option.short})`}
          value={fmtUsdPrecise(s.costUsd)}
        />
        <StatCard
          label="Avg latency"
          value={fmtMs(s.latencyAvgMs)}
          hint={
            s.lastRequestAt
              ? `last request ${fmtDateTime(s.lastRequestAt).full}`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Spend cap" className="lg:col-span-1">
          <SpendCapMeter
            spentUsd={u.lifetimeCostUsd}
            capUsd={scopes.spendCapUsd}
          />
        </Card>
        <Card title="Configuration" className="lg:col-span-2">
          <dl className="-my-2 divide-y divide-gray-50">
            <ScopeRow label="Endpoint">
              {key.endpoint ? (
                <code className="break-all text-xs text-gray-700">
                  {key.endpoint}
                </code>
              ) : (
                "—"
              )}
            </ScopeRow>
            <ScopeRow label="Default provider">
              {scopes.defaultProvider ?? (
                <span className="text-gray-400">None</span>
              )}
            </ScopeRow>
            <ScopeRow label="Allowed providers">
              <ScopeList values={scopes.providers} empty="All providers" />
            </ScopeRow>
            <ScopeRow label="Allowed models">
              <ScopeList values={scopes.models} empty="All models" />
            </ScopeRow>
            <ScopeRow label="IP allowlist">
              <ScopeList values={scopes.ipAllowlist} empty="Any IP" />
            </ScopeRow>
            <ScopeRow label="Created">{fmtDate(key.createdAt)}</ScopeRow>
            <ScopeRow label="Expires">
              {key.expiresAt ? fmtDate(key.expiresAt) : "Never"}
            </ScopeRow>
            <ScopeRow label="Last used">{fmtDate(key.lastUsedAt)}</ScopeRow>
          </dl>
        </Card>
      </div>

      <Card
        title="Traffic"
        subtitle={`Requests and spend per ${u.bucketSeconds >= 86400 ? "day" : "hour"}`}
      >
        {s.requests === 0 ? (
          <EmptyState title="No traffic in this time range" />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={series}
              margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="req"
                tick={{ fontSize: 11 }}
                allowDecimals={false}
              />
              <YAxis
                yAxisId="usd"
                orientation="right"
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => fmtUsd(Number(v), 4)}
              />
              <Tooltip
                formatter={(v, name) =>
                  name === "Spend"
                    ? fmtUsdPrecise(Number(v))
                    : fmtCount(Number(v))
                }
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar
                yAxisId="req"
                dataKey="ok"
                name="OK"
                stackId="r"
                fill="#a5b4fc"
              />
              <Bar
                yAxisId="req"
                dataKey="errors"
                name="Errors"
                stackId="r"
                fill="#f87171"
              />
              <Line
                yAxisId="usd"
                type="monotone"
                dataKey="cost"
                name="Spend"
                stroke="#4f46e5"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card title="Models" subtitle="Where this key's traffic went">
        {u.models.length === 0 ? (
          <EmptyState title="No traffic in this time range" />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 text-right font-medium">Requests</th>
                  <th className="px-5 py-3 text-right font-medium">Errors</th>
                  <th className="px-5 py-3 text-right font-medium">Spend</th>
                </tr>
              </thead>
              <tbody>
                {u.models.map((m) => (
                  <tr
                    key={`${m.provider}:${m.model}`}
                    tabIndex={0}
                    title="Show these requests"
                    onClick={() =>
                      navigate(
                        `${explorerBase}&provider=${encodeURIComponent(m.provider)}&model=${encodeURIComponent(m.model)}`,
                      )
                    }
                    className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="px-5 py-3 font-medium">{m.provider}</td>
                    <td className="px-5 py-3 text-gray-600">{m.model}</td>
                    <td className="px-5 py-3 text-right">
                      {fmtCount(m.requests)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {m.errors > 0 ? (
                        <Badge tone="red">{fmtCount(m.errors)}</Badge>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700">
                      {fmtUsdPrecise(m.costUsd)}
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
        subtitle={`Latest ${RECENT_LIMIT} in this time range`}
        actions={
          <Link
            to={explorerBase}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
          >
            View all →
          </Link>
        }
      >
        {recentRows.length === 0 ? (
          <EmptyState title="No requests in this time range" />
        ) : (
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Time</th>
                  <th className="px-5 py-3 font-medium">Model</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Latency</th>
                  <th className="px-5 py-3 text-right font-medium">
                    Tokens (in/out)
                  </th>
                  <th className="px-5 py-3 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentRows.map((r) => (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    onClick={() =>
                      navigate(
                        `${explorerBase}&request=${encodeURIComponent(r.id)}`,
                      )
                    }
                    className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="whitespace-nowrap px-5 py-3 text-gray-700">
                      {fmtDateTime(r.timestamp).full}
                    </td>
                    <td className="px-5 py-3 text-gray-600">
                      {r.model || "—"}
                    </td>
                    <td className="px-5 py-3">
                      <RequestStatusBadge
                        status={r.status_code}
                        error={r.error_message}
                      />
                    </td>
                    <td className="px-5 py-3">{fmtMs(r.latency_ms)}</td>
                    <td className="px-5 py-3 text-right text-gray-600">
                      {fmtTokens(r.tokens_input)} / {fmtTokens(r.tokens_output)}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-700">
                      {fmtUsdPrecise(r.cost_usd)}
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
