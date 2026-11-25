// [fork] The Live page's queue, inference and system-use charts.
import type { LivePoint } from "../lib/liveSeries";
import { LiveInferenceChart } from "./LiveInferenceChart";
import { LiveQueueChart } from "./LiveQueueChart";
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
  /** Shown instead of the charts when set (no samples). */
  empty?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card
        title="Queue"
        subtitle="Queued requests on the left · longest wait on the right"
      >
        {empty ?? <LiveQueueChart data={data} domain={domain} />}
      </Card>
      <Card title="KV pool and cache" subtitle="Percent in use or hit">
        {empty ?? <LiveInferenceChart data={data} domain={domain} />}
      </Card>
      <Card title="System use" subtitle="CPU, RAM, GPU and GPU memory in use">
        {empty ?? <LiveUsageChart data={data} domain={domain} />}
      </Card>
    </div>
  );
}
