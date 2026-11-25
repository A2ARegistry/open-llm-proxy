// [fork] W11: one live snapshot of the self-hosted box for the dashboard.
// Raw counters and gauges only; the dashboard derives rates between polls.
import {
  metricsBufferName,
  type MetricsBuffer,
} from "../durable/metrics-buffer";
import {
  latestRequestStatement,
  type RequestLogRow,
} from "../metrics/request-log";
import {
  parsePrometheus,
  promSum,
  promValue,
  type PromSample,
} from "./prometheus";
import { vpcProviders } from "./provider-binding";
import {
  fetchLiveText,
  hostBinding,
  inferenceBinding,
  type LiveBinding,
} from "./sources";
import {
  mergeThroughputRows,
  spreadThroughput,
  throughputRowsStatement,
  type ThroughputPoint,
  type ThroughputRequest,
} from "./throughput";

export interface InferenceSnapshot {
  binding: string;
  /** When the counters were read (ms): rates must use this, not `LiveSnapshot.at`. */
  sampledAt: number;
  version: string | null;
  slots: number | null;
  inFlight: number | null;
  queued: number | null;
  longestWaitS: number | null;
  kvUsageRatio: number | null;
  kvPoolPositions: number | null;
  kvReservedTokens: number | null;
  predictedTokensTotal: number | null;
  promptTokensTotal: number | null;
  cacheHitsTotal: number | null;
  cacheMissesTotal: number | null;
  cacheTokensSavedTotal: number | null;
  draftTokensTotal: number | null;
  draftAcceptedTotal: number | null;
}

export interface HostSnapshot {
  binding: string;
  /** When the counters were read (ms): rates must use this, not `LiveSnapshot.at`. */
  sampledAt: number;
  cpuIdleSecondsTotal: number | null;
  cpuSecondsTotal: number | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  gpuBusyPercent: number | null;
  gpuMemUsedBytes: number | null;
  gpuMemTotalBytes: number | null;
  cpuTempC: number | null;
  gpuTempC: number | null;
  ssdTempC: number | null;
  gpuPowerW: number | null;
}

export interface LiveSnapshot {
  at: number;
  inference: InferenceSnapshot | null;
  host: HostSnapshot | null;
  lastRequest: RequestLogRow | null;
  /** Request throughput of the last 10 minutes, one point per 10 s (idle = 0). */
  throughput: ThroughputPoint[];
}

const THROUGHPUT_WINDOW_S = 600;
const THROUGHPUT_BUCKET_S = 10;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseHealth(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const body: unknown = JSON.parse(json);
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function healthVersion(health: Record<string, unknown>): string | null {
  const version = health.version;
  if (typeof version === "string") return version;
  if (version && typeof version === "object") {
    const api = (version as Record<string, unknown>).api;
    if (typeof api === "string") return api;
  }
  return null;
}

/** Map an inference server's `/health` JSON and `/metrics` text; null when both are missing. */
export function toInference(
  binding: string,
  healthJson: string | null,
  metricsText: string | null,
  sampledAt: number = Date.now(),
): InferenceSnapshot | null {
  if (healthJson === null && metricsText === null) return null;
  const h = parseHealth(healthJson);
  const m = parsePrometheus(metricsText ?? "");
  return {
    binding,
    sampledAt,
    version:
      healthVersion(h) ??
      m.find((x) => x.name === "halogen:build_info")?.labels.version ??
      null,
    slots: num(h.slots),
    inFlight: num(h.in_flight) ?? promValue(m, "llamacpp:requests_processing"),
    queued: num(h.queued) ?? promValue(m, "llamacpp:requests_deferred"),
    longestWaitS:
      num(h.longest_wait_s) ??
      promValue(m, "halogen:queue_wait_longest_seconds"),
    kvUsageRatio: promValue(m, "llamacpp:kv_cache_usage_ratio"),
    kvPoolPositions:
      num(h.kv_pool_positions) ?? promValue(m, "halogen:kv_pool_positions"),
    kvReservedTokens: promValue(m, "halogen:kv_pool_reserved_tokens"),
    predictedTokensTotal: promValue(m, "llamacpp:tokens_predicted_total"),
    promptTokensTotal: promValue(m, "llamacpp:prompt_tokens_total"),
    cacheHitsTotal: promValue(m, "halogen:cache_hits_total"),
    cacheMissesTotal: promValue(m, "halogen:cache_misses_total"),
    cacheTokensSavedTotal: promValue(
      m,
      "halogen:cache_prompt_tokens_saved_total",
    ),
    draftTokensTotal: promValue(m, "halogen:draft_tokens_total"),
    draftAcceptedTotal: promValue(m, "halogen:draft_tokens_accepted_total"),
  };
}

/** hwmon chip label (e.g. a PCI path) → driver name (k10temp, amdgpu, nvme). */
function chipNames(m: PromSample[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const s of m) {
    if (s.name === "node_hwmon_chip_names" && s.labels.chip) {
      names.set(s.labels.chip, s.labels.chip_name ?? "");
    }
  }
  return names;
}

function hwmonValue(
  m: PromSample[],
  names: Map<string, string>,
  metric: string,
  driver: string,
  sensor: string,
): number | null {
  const hit = m.find(
    (s) =>
      s.name === metric &&
      s.labels.sensor === sensor &&
      names.get(s.labels.chip) === driver,
  );
  return hit?.value ?? null;
}

/** Map node_exporter `/metrics` text. GPU memory is GTT (shared system memory), not VRAM. */
export function toHost(
  binding: string,
  metricsText: string | null,
  sampledAt: number = Date.now(),
): HostSnapshot | null {
  if (metricsText === null) return null;
  const m = parsePrometheus(metricsText);
  const names = chipNames(m);
  const temp = (driver: string) =>
    hwmonValue(m, names, "node_hwmon_temp_celsius", driver, "temp1");
  return {
    binding,
    sampledAt,
    cpuIdleSecondsTotal: promSum(m, "node_cpu_seconds_total", { mode: "idle" }),
    cpuSecondsTotal: promSum(m, "node_cpu_seconds_total"),
    memTotalBytes: promValue(m, "node_memory_MemTotal_bytes"),
    memAvailableBytes: promValue(m, "node_memory_MemAvailable_bytes"),
    gpuBusyPercent: promValue(m, "node_drm_gpu_busy_percent"),
    gpuMemUsedBytes: promValue(m, "node_drm_memory_gtt_used_bytes"),
    gpuMemTotalBytes: promValue(m, "node_drm_memory_gtt_size_bytes"),
    cpuTempC: temp("k10temp"),
    gpuTempC: temp("amdgpu"),
    ssdTempC: temp("nvme"),
    gpuPowerW: hwmonValue(
      m,
      names,
      "node_hwmon_power_average_watt",
      "amdgpu",
      "power1",
    ),
  };
}

interface Timed {
  text: string | null;
  at: number;
}

/** Fetch `path` and note when its body arrived, so each source has its own sample time. */
async function timedFetch(
  binding: LiveBinding | null,
  path: "/health" | "/metrics",
): Promise<Timed> {
  const text = binding ? await fetchLiveText(binding.fetcher, path) : null;
  return { text, at: Date.now() };
}

/**
 * The last request and the throughput series, in one D1 batch. Throughput is
 * only for the org's vpc providers (none: no series).
 */
async function readRequestLog(
  env: Env,
  organizationId: string,
  nowMs: number,
): Promise<{
  lastRequest: RequestLogRow | null;
  throughput: ThroughputPoint[];
}> {
  const to =
    (Math.floor(nowMs / 1000 / THROUGHPUT_BUCKET_S) + 1) * THROUGHPUT_BUCKET_S;
  const from = to - THROUGHPUT_WINDOW_S;
  const providers = (await vpcProviders(env, organizationId)).map(
    (p) => p.provider,
  );
  const [[last, rows], pending] = await Promise.all([
    env.DB.batch([
      latestRequestStatement(env, organizationId),
      ...(providers.length > 0
        ? [throughputRowsStatement(env, organizationId, providers, from, to)]
        : []),
    ]),
    bufferedThroughputRows(env, organizationId, providers, from, to),
  ]);
  return {
    lastRequest: (last.results[0] as unknown as RequestLogRow) ?? null,
    throughput: rows
      ? spreadThroughput(
          mergeThroughputRows(
            rows.results as unknown as ThroughputRequest[],
            pending,
          ),
          from,
          to,
          THROUGHPUT_BUCKET_S,
        )
      : [],
  };
}

/**
 * Finished requests still in the org's MetricsBuffer (flushed to D1 only once
 * a minute). Best effort: a missing binding or failed call gives no rows, so
 * the series falls back to D1 alone.
 */
async function bufferedThroughputRows(
  env: Env,
  organizationId: string,
  providers: string[],
  from: number,
  to: number,
): Promise<ThroughputRequest[]> {
  const ns = (env as { METRICS_BUFFER?: DurableObjectNamespace<MetricsBuffer> })
    .METRICS_BUFFER;
  if (!ns || providers.length === 0) return [];
  try {
    const stub = ns.get(ns.idFromName(metricsBufferName(organizationId)));
    return await stub.throughputRows(organizationId, providers, from, to);
  } catch (err) {
    console.error("MetricsBuffer throughput read failed", err);
    return [];
  }
}

/** Read every live source for `organizationId` in parallel (one D1 batch, no writes). */
export async function buildLiveSnapshot(
  env: Env,
  organizationId: string,
): Promise<LiveSnapshot> {
  const inference = inferenceBinding(env, organizationId);
  const host = hostBinding(env, organizationId);
  const [health, inferenceMetrics, hostMetrics, requestLog] = await Promise.all(
    [
      timedFetch(inference, "/health"),
      timedFetch(inference, "/metrics"),
      timedFetch(host, "/metrics"),
      readRequestLog(env, organizationId, Date.now()),
    ],
  );
  return {
    at: Date.now(),
    inference: inference
      ? toInference(
          inference.name,
          health.text,
          inferenceMetrics.text,
          inferenceMetrics.at,
        )
      : null,
    host: host ? toHost(host.name, hostMetrics.text, hostMetrics.at) : null,
    ...requestLog,
  };
}
