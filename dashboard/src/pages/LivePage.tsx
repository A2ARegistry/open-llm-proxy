// [fork] W11: live view of the self-hosted box (throughput, queue, KV,
// cache, CPU/RAM/GPU, temperatures, power). Polls GET /api/live; history
// lives only in this page's memory.
import { LiveGauge } from "../components/LiveGauge";
import { Badge, Card, EmptyState, Spinner, StatCard } from "../components/ui";
import { apiGet, type LiveSnapshot } from "../lib/api";
import {
  fmtCount,
  fmtDateTime,
  fmtMs,
  fmtTokens,
  fmtTps,
  pct,
  rowDecodeTps,
} from "../lib/format";
import {
  LIVE_POLL_MS,
  appendPoint,
  ratio,
  toPoint,
  type LivePoint,
} from "../lib/liveSeries";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const UNAVAILABLE = "Unavailable";

function fmtGb(bytes: number | null): string {
  return bytes === null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtC(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} °C`;
}

function peak(
  points: LivePoint[],
  key: "decodeTps" | "prefillTps",
): number | null {
  const values = points
    .map((p) => p[key])
    .filter((v): v is number => v !== null);
  return values.length ? Math.max(...values) : null;
}

function latest(points: LivePoint[]): LivePoint | null {
  return points.length ? points[points.length - 1] : null;
}

export function LivePage() {
  const [points, setPoints] = useState<LivePoint[]>([]);
  const prev = useRef<LiveSnapshot | null>(null);

  const live = useQuery({
    queryKey: ["live"],
    queryFn: () => apiGet<{ snapshot: LiveSnapshot }>("/api/live"),
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const snapshot = live.data?.snapshot ?? null;

  useEffect(() => {
    if (!snapshot || prev.current?.at === snapshot.at) return;
    setPoints((current) =>
      appendPoint(current, toPoint(prev.current, snapshot)),
    );
    prev.current = snapshot;
  }, [snapshot]);

  if (live.isLoading) return <Spinner />;
  if (!snapshot) {
    return (
      <EmptyState
        title="Live data unavailable"
        description={
          live.error instanceof Error ? live.error.message : undefined
        }
      />
    );
  }

  const inf = snapshot.inference;
  const host = snapshot.host;
  const now = latest(points);
  const memUsed =
    host?.memTotalBytes != null && host.memAvailableBytes != null
      ? host.memTotalBytes - host.memAvailableBytes
      : null;
  const cacheRate = inf
    ? ratio(
        inf.cacheHitsTotal,
        inf.cacheHitsTotal !== null && inf.cacheMissesTotal !== null
          ? inf.cacheHitsTotal + inf.cacheMissesTotal
          : null,
      )
    : null;
  const draftRate = inf
    ? ratio(inf.draftAcceptedTotal, inf.draftTokensTotal)
    : null;
  const last = snapshot.lastRequest;
  const chartData = points.map((p) => ({ ...p, label: fmtClock(p.t) }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Live</h1>
          <p className="text-sm text-gray-500">
            Throughput, capacity and hardware of the self-hosted server, every{" "}
            {LIVE_POLL_MS / 1000} s. History is kept while this page is open.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {inf?.version && <Badge tone="gray">v{inf.version}</Badge>}
          <Badge tone={live.isError ? "red" : "green"}>
            {live.isError
              ? "Connection lost"
              : `Updated ${fmtClock(snapshot.at)}`}
          </Badge>
        </div>
      </div>

      <Card
        title="Aggregate throughput"
        subtitle={
          inf
            ? `Decode ${fmtTps(now?.decodeTps)} (peak ${fmtTps(peak(points, "decodeTps"))}) · Prefill ${fmtTps(now?.prefillTps)} (peak ${fmtTps(peak(points, "prefillTps"))})`
            : UNAVAILABLE
        }
      >
        {inf ? (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart
              data={chartData}
              margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11 }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis yAxisId="decode" tick={{ fontSize: 11 }} />
              <YAxis
                yAxisId="prefill"
                orientation="right"
                tick={{ fontSize: 11 }}
              />
              <Tooltip formatter={(v) => fmtTps(Number(v))} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area
                yAxisId="decode"
                type="monotone"
                dataKey="decodeTps"
                name="Decode"
                stroke="#f59e0b"
                fill="#fde68a"
                isAnimationActive={false}
                connectNulls={false}
              />
              <Area
                yAxisId="prefill"
                type="monotone"
                dataKey="prefillTps"
                name="Prefill"
                stroke="#3b82f6"
                fill="#bfdbfe"
                fillOpacity={0.4}
                isAnimationActive={false}
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState title="Inference server unavailable" />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active requests"
          value={
            inf ? `${inf.inFlight ?? "—"} / ${inf.slots ?? "—"}` : UNAVAILABLE
          }
          hint={
            inf
              ? `${inf.queued ?? "—"} queued · longest wait ${fmtMs(inf.longestWaitS === null ? null : inf.longestWaitS * 1000)}`
              : undefined
          }
          tone={inf?.queued ? "red" : "default"}
        />
        <StatCard
          label="KV pool"
          value={
            inf?.kvUsageRatio != null ? pct(inf.kvUsageRatio) : UNAVAILABLE
          }
          hint={
            inf
              ? `${fmtTokens(inf.kvReservedTokens)} reserved of ${fmtTokens(inf.kvPoolPositions)}`
              : undefined
          }
        />
        <StatCard
          label="Prompt cache hits"
          value={cacheRate !== null ? pct(cacheRate) : UNAVAILABLE}
          hint={
            inf
              ? `${fmtTokens(inf.cacheTokensSavedTotal)} tokens saved`
              : undefined
          }
          tone={cacheRate !== null && cacheRate >= 0.8 ? "green" : "default"}
        />
        <StatCard
          label="Draft acceptance"
          value={draftRate !== null ? pct(draftRate) : UNAVAILABLE}
          hint={
            inf ? `${fmtCount(inf.draftTokensTotal)} drafted tokens` : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="System vitals" subtitle={host ? undefined : UNAVAILABLE}>
          {host ? (
            <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
              <LiveGauge label="CPU" percent={now?.cpuPercent ?? null} />
              <LiveGauge
                label="RAM"
                percent={
                  memUsed !== null && host.memTotalBytes
                    ? (memUsed / host.memTotalBytes) * 100
                    : null
                }
                hint={`${fmtGb(memUsed)} of ${fmtGb(host.memTotalBytes)}`}
              />
              <LiveGauge label="GPU" percent={host.gpuBusyPercent} />
              <LiveGauge
                label="GPU memory"
                percent={
                  host.gpuMemUsedBytes !== null && host.gpuMemTotalBytes
                    ? (host.gpuMemUsedBytes / host.gpuMemTotalBytes) * 100
                    : null
                }
                hint={`${fmtGb(host.gpuMemUsedBytes)} · shared pool`}
              />
            </div>
          ) : (
            <EmptyState title="Host metrics unavailable" />
          )}
        </Card>

        <Card
          title="Temperatures and power"
          subtitle={
            host
              ? `CPU ${fmtC(host.cpuTempC)} · GPU ${fmtC(host.gpuTempC)} · SSD ${fmtC(host.ssdTempC)} · APU power ${host.gpuPowerW === null ? "—" : `${host.gpuPowerW.toFixed(0)} W`}`
              : UNAVAILABLE
          }
        >
          {host ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={chartData}
                margin={{ top: 5, right: 10, bottom: 0, left: -10 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis yAxisId="c" tick={{ fontSize: 11 }} unit="°" />
                <YAxis
                  yAxisId="w"
                  orientation="right"
                  tick={{ fontSize: 11 }}
                  unit="W"
                />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  yAxisId="c"
                  dataKey="cpuTempC"
                  name="CPU °C"
                  stroke="#ef4444"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="c"
                  dataKey="gpuTempC"
                  name="GPU °C"
                  stroke="#f59e0b"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="c"
                  dataKey="ssdTempC"
                  name="SSD °C"
                  stroke="#10b981"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="w"
                  dataKey="gpuPowerW"
                  name="APU W"
                  stroke="#6366f1"
                  strokeDasharray="4 2"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState title="Host metrics unavailable" />
          )}
        </Card>
      </div>

      <Card
        title="Last inference"
        subtitle={
          last
            ? `${last.model} · ${fmtDateTime(last.timestamp).full}`
            : undefined
        }
      >
        {last ? (
          <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
            <StatCard
              label="Decode"
              value={fmtTps(rowDecodeTps(last.tokens_output, last.decode_ms))}
            />
            <StatCard label="TTFT" value={fmtMs(last.ttft_ms)} />
            <StatCard
              label="Prompt tokens"
              value={fmtTokens(last.tokens_input)}
            />
            <StatCard
              label="Completion tokens"
              value={fmtTokens(last.tokens_output)}
            />
          </div>
        ) : (
          <EmptyState title="No requests yet" />
        )}
      </Card>
    </div>
  );
}
