// [fork] W12: the Live page for a past range: stored box history (10 s rows,
// or 10-min rows beyond 2 h) instead of the 2 s poll.
import type { LiveHistory } from "../lib/api";
import { fmtTps } from "../lib/format";
import {
  bucketLabel,
  fmtC,
  fmtGb,
  fmtPctValue,
  hasStoredSamples,
} from "../lib/liveChart";
import { summarize, type HistoryPoint } from "../lib/liveHistory";
import { LiveGauge } from "./LiveGauge";
import { LiveTempChart } from "./LiveTempChart";
import { LiveThroughputChart } from "./LiveThroughputChart";
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
      {header(`Stored samples, ${bucketLabel(history.bucketS)} resolution`)}

      <Card
        title="Aggregate throughput"
        subtitle={`Decode avg ${fmtTps(sum.avgDecodeTps)} (peak ${fmtTps(sum.peakDecodeTps)})`}
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="System vitals" subtitle="Peak over the range">
          <div className="grid grid-cols-3 gap-4 p-5">
            <LiveGauge label="CPU" percent={sum.peakCpuPct} />
            <LiveGauge label="GPU" percent={sum.peakGpuPct} />
            <LiveGauge
              label="GPU memory"
              percent={null}
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
