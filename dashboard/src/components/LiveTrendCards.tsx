// [fork] The Live page's inference and system-use charts, side by side.
import type { LivePoint } from "../lib/liveSeries";
import { LiveInferenceChart } from "./LiveInferenceChart";
import { LiveUsageChart } from "./LiveUsageChart";
import { Card } from "./ui";
import type { ReactNode } from "react";

export function LiveTrendCards({
  data,
  domain,
  empty,
}: {
  data: LivePoint[];
  /** [from, to] in ms. */
  domain: [number, number];
  /** Shown instead of both charts when set (no samples). */
  empty?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card
        title="Queue, KV pool and cache"
        subtitle="Percent on the left · queued requests on the right"
      >
        {empty ?? <LiveInferenceChart data={data} domain={domain} />}
      </Card>
      <Card title="System use" subtitle="CPU, RAM, GPU and GPU memory in use">
        {empty ?? <LiveUsageChart data={data} domain={domain} />}
      </Card>
    </div>
  );
}
