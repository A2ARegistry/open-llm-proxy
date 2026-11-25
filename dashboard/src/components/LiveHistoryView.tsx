// [fork] W12: the Live page for a past range: stored box history (10 s rows,
// or 10-min rows beyond 2 h) instead of the 2 s poll.
import type { LiveHistory } from "../lib/api";
import {
  fmtC,
  fmtGb,
  fmtPctValue,
  hasStoredSamples,
  historySubtitle,
} from "../lib/liveChart";
import { summarize, type HistoryPoint } from "../lib/liveHistory";
import { LiveGauge } from "./LiveGauge";
import { LiveTempChart } from "./LiveTempChart";
import {
  DECODE_COLOR,
  LiveThroughputChart,
  PREFILL_COLOR,
} from "./LiveThroughputChart";
import { LiveTrendCards } from "./LiveTrendCards";
import { ThroughputStat } from "./ThroughputStat";
import { Card, EmptyState, Spinner, StatCard } from "./ui";
import type { ReactNode } from "react";

const NO_SAMPLES = "No stored samples in this range.";

export function LiveHistoryView({
  control,
  loading,
  error,
  history,
  data,
  domain,
}: {
  control: ReactNode;
  loading: boolean;
  error: unknown;
  history: LiveHistory | null;
  data: HistoryPoint[];
  /** [from, to] in ms. */
  domain: [number, number];
}) {
  const header = (subtitle: ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Live</h1>
        <p className="text-sm text-gray-500">{subtitle}</p>
      </div>
      {control}
    </div>
  );

  if (loading) {
    return (
      <div className="space-y-6">
        {header("Loading stored samples…")}
        <Spinner />
      </div>
    );
  }
  if (!history) {
    return (
      <div className="space-y-6">
        {header("Stored samples")}
        <EmptyState
          title="History unavailable"
          description={error instanceof Error ? error.message : undefined}
        />
      </div>
    );
  }

  const stored = hasStoredSamples(history);
  const sum = summarize(history);
  const empty = <EmptyState title={NO_SAMPLES} />;
  return (
    <div className="space-y-6">
      {header(historySubtitle(history.bucketS))}

      <Card
        title="Aggregate throughput"
        subtitle="Average over the range · from finished requests"
        actions={
          <div className="flex gap-6">
            <ThroughputStat
              label="Decode avg"
              color={DECODE_COLOR}
              value={sum.avgDecodeTps}
              peak={sum.peakDecodeTps}
            />
            <ThroughputStat
              label="Prefill avg"
              color={PREFILL_COLOR}
              value={sum.avgPrefillTps}
              peak={sum.peakPrefillTps}
            />
          </div>
        }
      >
        {stored ? <LiveThroughputChart data={data} domain={domain} /> : empty}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Queued (peak)"
          value={sum.peakQueued ?? "—"}
          tone={sum.peakQueued ? "red" : "default"}
        />
        <StatCard
          label="KV pool (avg)"
          value={fmtPctValue(sum.avgKvPct)}
          hint={`peak ${fmtPctValue(sum.peakKvPct)}`}
        />
        <StatCard
          label="Prompt cache hits (avg)"
          value={fmtPctValue(sum.avgCacheHitPct)}
        />
        <StatCard
          label="Draft acceptance (avg)"
          value={fmtPctValue(sum.avgDraftPct)}
        />
      </div>

      <LiveTrendCards
        data={data}
        domain={domain}
        empty={stored ? undefined : empty}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="System vitals" subtitle="Peak over the range">
          <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
            <LiveGauge label="CPU" percent={sum.peakCpuPct} />
            <LiveGauge
              label="RAM"
              percent={sum.peakRamPct}
              hint={`peak ${fmtGb(sum.peakRamBytes)} in use`}
            />
            <LiveGauge label="GPU" percent={sum.peakGpuPct} />
            <LiveGauge
              label="GPU memory"
              percent={sum.peakGpuMemPct}
              hint={`peak ${fmtGb(sum.peakGpuMemBytes)}`}
            />
          </div>
        </Card>

        <Card
          title="Temperatures and power"
          subtitle={`Peak CPU ${fmtC(sum.peakCpuTempC)} · GPU ${fmtC(sum.peakGpuTempC)}`}
        >
          {stored ? <LiveTempChart data={data} domain={domain} /> : empty}
        </Card>
      </div>
    </div>
  );
}
