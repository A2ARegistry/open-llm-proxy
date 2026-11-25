// [fork] W11: live view of the self-hosted box (throughput, queue, KV,
// cache, CPU/RAM/GPU, temperatures, power). Live mode polls GET /api/live and
// keeps ~10 min of points in the browser, seeded on load with the stored 10 s
// samples of that window so a reload does not empty the charts; past ranges
// read the stored history (GET /api/live/history) through LiveHistoryView.
import { LiveGauge } from "../components/LiveGauge";
import { LiveHistoryView } from "../components/LiveHistoryView";
import { LiveTempChart } from "../components/LiveTempChart";
import {
  DECODE_COLOR,
  LiveThroughputChart,
  PREFILL_COLOR,
} from "../components/LiveThroughputChart";
import { ThroughputStat } from "../components/ThroughputStat";
import { TimeRangeControl } from "../components/TimeRangeControl";
import { Badge, Card, EmptyState, Spinner, StatCard } from "../components/ui";
import { apiGet, liveHistory, type LiveSnapshot } from "../lib/api";
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
  fmtC,
  fmtGb,
  liveWindow,
  seededLivePoints,
  throughputEmptyTitle,
  throughputPoints,
  throughputStats,
} from "../lib/liveChart";
import { LIVE_RANGES, historyPoints } from "../lib/liveHistory";
import {
  LIVE_POLL_MS,
  advanceLive,
  ratio,
  type LiveSeriesState,
} from "../lib/liveSeries";
import type { RangePreset } from "../lib/timeRange";
import { useLiveRange } from "../lib/useLiveRange";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

const UNAVAILABLE = "Unavailable";
const PRESETS = LIVE_RANGES.filter((r): r is RangePreset => r !== "live");
const LIVE_OPTION = { value: "live", label: "Live" };

function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LivePage() {
  const time = useLiveRange();
  const [series, setSeries] = useState<LiveSeriesState>({
    prev: null,
    points: [],
  });

  const live = useQuery({
    queryKey: ["live"],
    queryFn: () => apiGet<{ snapshot: LiveSnapshot }>("/api/live"),
    enabled: time.isLive,
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const snapshot = live.data?.snapshot ?? null;

  const stored = useQuery({
    queryKey: ["live-history", time.start, time.end, time.refreshes],
    queryFn: () => liveHistory(time.start, time.end),
    enabled: !time.isLive,
    staleTime: Infinity,
  });
  const history = stored.data ?? null;

  // Stored samples of the live window, read once per visit so the charts
  // start full. Not cached: a later visit needs the samples of its own window.
  const seed = useQuery({
    queryKey: ["live-seed"],
    queryFn: () => {
      const [from, to] = liveWindow(Date.now());
      return liveHistory(Math.floor(from / 1000), Math.ceil(to / 1000));
    },
    enabled: time.isLive,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const seedPoints = useMemo(
    () => (seed.data ? historyPoints(seed.data) : []),
    [seed.data],
  );

  useEffect(() => {
    if (snapshot) setSeries((current) => advanceLive(current, snapshot));
  }, [snapshot]);

  const windowStart = snapshot ? liveWindow(snapshot.at)[0] : 0;
  const livePoints = useMemo(
    () => seededLivePoints(seedPoints, series.points, windowStart),
    [seedPoints, series.points, windowStart],
  );
  const historyData = useMemo(
    () => (history ? historyPoints(history) : []),
    [history],
  );

  const control = (
    <TimeRangeControl
      time={{
        range: time.range,
        setRange: time.setRange,
        refresh: time.isLive ? () => void live.refetch() : time.refresh,
      }}
      allowed={PRESETS}
      leading={LIVE_OPTION}
      refreshing={time.isLive ? live.isFetching : stored.isFetching}
    />
  );

  if (!time.isLive) {
    return (
      <LiveHistoryView
        control={control}
        loading={stored.isLoading}
        error={stored.error}
        history={history}
        data={historyData}
        domain={[time.start * 1000, time.end * 1000]}
      />
    );
  }

  if (live.isLoading) return <Spinner />;
  if (!snapshot) {
    return (
      <div className="space-y-6">
        <div className="flex justify-end">{control}</div>
        <EmptyState
          title="Live data unavailable"
          description={
            live.error instanceof Error ? live.error.message : undefined
          }
        />
      </div>
    );
  }

  const inf = snapshot.inference;
  const host = snapshot.host;
  const now = series.points.length
    ? series.points[series.points.length - 1]
    : null;
  const domain = liveWindow(snapshot.at);
  const tps = throughputStats(snapshot.throughput);
  const throughputEmpty = throughputEmptyTitle(snapshot.throughput);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Live</h1>
          <p className="text-sm text-gray-500">
            Throughput, capacity and hardware of the self-hosted server, every{" "}
            {LIVE_POLL_MS / 1000} s. This view keeps the last ~10 min; pick a
            range for stored history.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {inf?.version && <Badge tone="gray">v{inf.version}</Badge>}
          <Badge tone={live.isError ? "red" : "green"}>
            {live.isError
              ? "Connection lost"
              : `Updated ${fmtClock(snapshot.at)}`}
          </Badge>
          {control}
        </div>
      </div>

      <Card
        title="Aggregate throughput"
        subtitle={
          throughputEmpty === null
            ? "From finished requests · 10 s buckets"
            : undefined
        }
        actions={
          throughputEmpty === null ? (
            <div className="flex gap-6">
              <ThroughputStat
                label="Decode"
                color={DECODE_COLOR}
                value={tps.decodeNow}
                peak={tps.decodePeak}
              />
              <ThroughputStat
                label="Prefill"
                color={PREFILL_COLOR}
                value={tps.prefillNow}
                peak={tps.prefillPeak}
              />
            </div>
          ) : undefined
        }
      >
        {throughputEmpty === null ? (
          <LiveThroughputChart
            data={throughputPoints(snapshot.throughput)}
            domain={domain}
          />
        ) : (
          <EmptyState title={throughputEmpty} />
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
            <LiveTempChart data={livePoints} domain={domain} />
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
