import { apiGet, liveAt, RequestDetail, SampleAt } from "../lib/api";
import {
  fmtDateTime,
  fmtMs,
  fmtTokens,
  fmtTps,
  fmtUsdPrecise,
  rowDecodeTps,
} from "../lib/format";
import { smallestLivePreset } from "../lib/liveRangeFor";
import { NO_API_KEY } from "../lib/requestExplorer";
import { RequestCacheBadge } from "./RequestCacheBadge";
import { RequestStatusBadge } from "./RequestStatusBadge";
import { Badge, EmptyState, Spinner } from "./ui";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { ReactNode, useEffect } from "react";
import { Link } from "react-router-dom";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 text-right text-gray-900">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
        {title}
      </h4>
      <dl className="divide-y divide-gray-50">{children}</dl>
    </section>
  );
}

function FilterLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
    >
      {children}
    </button>
  );
}

/** Uncached input tokens / TTFT, the same rate the speed table reports. */
function prefillTps(r: RequestDetail): number | null {
  if (!r.ttft_ms || r.ttft_ms <= 0 || !r.tokens_input) return null;
  return (r.tokens_input * 1000) / r.ttft_ms;
}

const dash = (v: number | null | undefined, fmt: (n: number) => string) =>
  v === null || v === undefined ? "—" : fmt(v);

function BoxAtThatTime({ s, tsSeconds }: { s: SampleAt; tsSeconds: number }) {
  const inf = s.inference;
  const host = s.host;
  const whole = (n: number) => String(Math.round(n));
  const deg = (n: number) => `${Math.round(n)} °C`;
  const inFlightQueued =
    inf && (inf.in_flight !== null || inf.queued !== null)
      ? `${inf.in_flight ?? "—"} / ${inf.queued ?? "—"}`
      : "—";
  const range = smallestLivePreset(tsSeconds, Date.now());

  return (
    <div className="space-y-1">
      <Section title="Box at that time">
        <Field label="In flight / queued">{inFlightQueued}</Field>
        <Field label="KV cache">
          {dash(inf?.kv_usage_ratio, (n) => `${whole(n * 100)}%`)}
        </Field>
        <Field label="GPU busy">
          {dash(host?.gpu_busy_pct, (n) => `${whole(n)}%`)}
        </Field>
        <Field label="CPU temp">{dash(host?.cpu_temp_c, deg)}</Field>
        <Field label="GPU temp">{dash(host?.gpu_temp_c, deg)}</Field>
      </Section>
      {s.resolutionS === 600 && (
        <p className="text-xs text-gray-400">(10 min average)</p>
      )}
      <Link
        to={`/live?range=${range}`}
        className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
      >
        Open on Live
      </Link>
    </div>
  );
}

function DetailBody({
  r,
  onFilter,
}: {
  r: RequestDetail;
  onFilter: (key: "apiKeyId" | "model" | "provider", value: string) => void;
}) {
  const when = fmtDateTime(r.timestamp);
  const input = r.tokens_input ?? 0;
  const cacheRead = r.tokens_cache_read ?? 0;
  const cacheWrite = r.tokens_cache_write ?? 0;
  const output = r.tokens_output ?? 0;
  const box = useQuery({
    queryKey: ["live-at", r.id],
    queryFn: () => liveAt(r.id),
    staleTime: Infinity,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <RequestStatusBadge status={r.status_code} />
          <RequestCacheBadge row={r} />
          <Badge>{r.method}</Badge>
        </div>
        <p className="text-sm text-gray-500">{when.full}</p>
        <p className="break-all font-mono text-[11px] text-gray-400">{r.id}</p>
      </div>

      {r.error_message && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-xs font-semibold text-red-800">Error</p>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-red-700">
            {r.error_message}
          </pre>
        </div>
      )}

      <Section title="Route">
        <Field label="Provider">
          <div className="flex flex-col items-end">
            <span className="font-medium">{r.provider}</span>
            <FilterLink onClick={() => onFilter("provider", r.provider)}>
              All requests to this provider
            </FilterLink>
          </div>
        </Field>
        <Field label="Model">
          <div className="flex flex-col items-end">
            <span className="break-all">{r.model || "—"}</span>
            {r.model && (
              <FilterLink onClick={() => onFilter("model", r.model)}>
                All requests to this model
              </FilterLink>
            )}
          </div>
        </Field>
        <Field label="Caller">
          {r.api_key_id ? (
            <div className="flex flex-col items-end">
              <span className="flex items-center gap-1.5">
                <span className="font-medium">
                  {r.key_name ?? "Deleted key"}
                </span>
                {r.key_prefix && (
                  <span className="font-mono text-[11px] text-gray-400">
                    {r.key_prefix}…
                  </span>
                )}
                {r.key_status === "revoked" && (
                  <Badge tone="amber">revoked</Badge>
                )}
              </span>
              <FilterLink onClick={() => onFilter("apiKeyId", r.api_key_id!)}>
                All requests from this key
              </FilterLink>
            </div>
          ) : (
            <div className="flex flex-col items-end">
              <span className="font-medium">
                {r.user_name ?? "Dashboard (no key)"}
              </span>
              {r.user_email && (
                <span className="text-xs text-gray-500">{r.user_email}</span>
              )}
              <FilterLink onClick={() => onFilter("apiKeyId", NO_API_KEY)}>
                All keyless requests
              </FilterLink>
            </div>
          )}
        </Field>
      </Section>

      <Section title="Timing">
        <Field label="Total latency">{fmtMs(r.latency_ms)}</Field>
        <Field label="Time to first token">{fmtMs(r.ttft_ms)}</Field>
        <Field label="Decode time">{fmtMs(r.decode_ms)}</Field>
        <Field label="Decode speed">
          {fmtTps(rowDecodeTps(r.tokens_output, r.decode_ms))}
        </Field>
        <Field label="Prefill speed">{fmtTps(prefillTps(r))}</Field>
      </Section>

      <Section title="Tokens">
        <Field label="Input (uncached)">{fmtTokens(input)}</Field>
        <Field label="Prompt cache read">{fmtTokens(cacheRead)}</Field>
        <Field label="Prompt cache write">{fmtTokens(cacheWrite)}</Field>
        <Field label="Output">{fmtTokens(output)}</Field>
        <Field label="Total">
          <span className="font-medium">
            {fmtTokens(input + cacheRead + cacheWrite + output)}
          </span>
        </Field>
      </Section>

      <Section title="Cost">
        <Field label="Cost">
          <span
            className="font-medium"
            title={
              r.cost_usd ? `$${Number(r.cost_usd.toPrecision(6))}` : undefined
            }
          >
            {fmtUsdPrecise(r.cost_usd)}
          </span>
        </Field>
      </Section>

      {box.data && <BoxAtThatTime s={box.data} tsSeconds={r.timestamp} />}
    </div>
  );
}

/** Side panel with one request's full record. */
export function RequestDetailDrawer({
  requestId,
  onClose,
  onFilter,
}: {
  requestId: string | null;
  onClose: () => void;
  onFilter: (key: "apiKeyId" | "model" | "provider", value: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["request-detail", requestId],
    queryFn: () =>
      apiGet<{ request: RequestDetail }>(
        `/api/metrics/requests/${encodeURIComponent(requestId!)}`,
      ),
    enabled: !!requestId,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!requestId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestId, onClose]);

  if (!requestId) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Request details"
        className="relative flex h-full w-full max-w-md flex-col bg-white shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-gray-900">
            Request details
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {detail.isLoading ? (
            <Spinner label="Loading request…" />
          ) : detail.error ? (
            <EmptyState
              title="Could not load request"
              description={detail.error.message}
            />
          ) : (
            <DetailBody r={detail.data!.request} onFilter={onFilter} />
          )}
        </div>
      </aside>
    </div>
  );
}
