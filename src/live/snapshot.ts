// [fork] W11: one live snapshot of the self-hosted box for the dashboard.
// Raw counters and gauges only; the dashboard derives rates between polls.
import { latestRequest, type RequestLogRow } from "../metrics/request-log";
import {
  parsePrometheus,
  promSum,
  promValue,
  type PromSample,
} from "./prometheus";
import { fetchLiveText, hostBinding, inferenceBinding } from "./sources";

export interface InferenceSnapshot {
  binding: string;
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
}

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
): InferenceSnapshot | null {
  if (healthJson === null && metricsText === null) return null;
  const h = parseHealth(healthJson);
  const m = parsePrometheus(metricsText ?? "");
  return {
    binding,
    version: healthVersion(h),
    slots: num(h.slots),
    inFlight: num(h.in_flight) ?? promValue(m, "llamacpp:requests_processing"),
    queued: num(h.queued) ?? promValue(m, "llamacpp:requests_deferred"),
    longestWaitS: num(h.longest_wait_s),
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
): HostSnapshot | null {
  if (metricsText === null) return null;
  const m = parsePrometheus(metricsText);
  const names = chipNames(m);
  const temp = (driver: string) =>
    hwmonValue(m, names, "node_hwmon_temp_celsius", driver, "temp1");
  return {
    binding,
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

/** Read every live source for `organizationId` in parallel (one D1 read, no writes). */
export async function buildLiveSnapshot(
  env: Env,
  organizationId: string,
): Promise<LiveSnapshot> {
  const inference = inferenceBinding(env, organizationId);
  const host = hostBinding(env, organizationId);
  const [health, inferenceMetrics, hostMetrics, lastRequest] =
    await Promise.all([
      inference ? fetchLiveText(inference.fetcher, "/health") : null,
      inference ? fetchLiveText(inference.fetcher, "/metrics") : null,
      host ? fetchLiveText(host.fetcher, "/metrics") : null,
      latestRequest(env, organizationId),
    ]);
  return {
    at: Date.now(),
    inference: inference
      ? toInference(inference.name, health, inferenceMetrics)
      : null,
    host: host ? toHost(host.name, hostMetrics) : null,
    lastRequest,
  };
}
