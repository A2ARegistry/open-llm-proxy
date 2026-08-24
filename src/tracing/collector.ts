/**
 * Abstract Tracing & Observability Interface.
 *
 * When a provider has `settings.trace = true`, detailed incoming/outgoing
 * payloads (raw request, converted adapter request, upstream raw response,
 * and converted OpenAI response) are collected into a `TraceEvent`.
 *
 * The `TraceCollector` interface decouples storage from execution:
 * - Current default: `ConsoleTraceCollector` (writes structured JSON to CF Worker logs)
 * - Future backends: R2TraceCollector (Cloudflare R2 Object Storage), S3,
 *   Datadog, Axiom, etc. — implement `TraceCollector` and call
 *   `setTraceCollector()` at boot; nothing else changes.
 */

export interface TraceEvent {
  id: string;
  timestamp: number;
  organizationId: string;
  apiKeyId?: string;
  provider: string;
  model: string;
  stream: boolean;
  /** Inbound OpenAI-compatible chat completion request body (raw / parsed) */
  inboundRequest?: unknown;
  /** Outbound request payload sent to upstream adapter/API after translation */
  upstreamRequest?: {
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  /** Upstream response payload (or stream summary) received from the provider */
  upstreamResponse?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    chunksCount?: number;
    error?: unknown;
  };
  /** Final OpenAI-compatible response body returned to client */
  outboundResponse?: unknown;
  latencyMs?: number;
}

export interface TraceCollector {
  record(event: TraceEvent): Promise<void> | void;
}

/**
 * Standard Console-based Trace Collector (Cloudflare Worker Logs).
 * Emits clean, parseable JSON blocks with a clear prefix.
 *
 * Note: traces are opt-in per provider (`settings.trace`) and intentionally
 * bypass LOG_LEVEL — if you asked for tracing you asked for the payloads.
 */
export class ConsoleTraceCollector implements TraceCollector {
  record(event: TraceEvent): void {
    const header = `[TRACE] provider=${event.provider} model=${event.model} stream=${event.stream} latency=${event.latencyMs ?? 0}ms traceId=${event.id}`;
    console.log(header);
    console.log(
      JSON.stringify(
        {
          _type: "proxy_trace",
          id: event.id,
          timestamp: new Date(event.timestamp).toISOString(),
          org: event.organizationId,
          keyId: event.apiKeyId,
          provider: event.provider,
          model: event.model,
          stream: event.stream,
          latencyMs: event.latencyMs,
          inboundRequest: event.inboundRequest,
          upstreamRequest: event.upstreamRequest,
          upstreamResponse: event.upstreamResponse,
          outboundResponse: event.outboundResponse,
        },
        null,
        2,
      ),
    );
  }
}

let activeCollector: TraceCollector = new ConsoleTraceCollector();

export function setTraceCollector(collector: TraceCollector): void {
  activeCollector = collector;
}

export function getTraceCollector(): TraceCollector {
  return activeCollector;
}

// ---------------------------------------------------------------------------
// TraceSession — ergonomic builder used by the request path.
// ---------------------------------------------------------------------------

/** Headers that must never appear in a trace. Values are replaced. */
const REDACTED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

/** Per-field serialized size cap so one trace can't blow up log ingestion. */
const MAX_FIELD_BYTES = 512 * 1024;

const TRUNCATION_MARKER = "…[truncated]";

function newTraceId(): string {
  return `trace_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Deep-copy a value as JSON, capping each top-level serialized field. */
function capped(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
  if (text === undefined) return undefined;
  if (text.length <= MAX_FIELD_BYTES) {
    return typeof value === "string" ? value : JSON.parse(text);
  }
  const truncated = text.slice(0, MAX_FIELD_BYTES) + TRUNCATION_MARKER;
  try {
    // Keep it valid JSON when possible so log tooling can parse it.
    return JSON.parse(`"${truncated.replace(/"/g, '\\"')}"`);
  } catch {
    return truncated;
  }
}

export function sanitizeHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

interface TraceSessionMeta {
  organizationId: string;
  apiKeyId?: string;
  provider: string;
  model: string;
  stream: boolean;
}

/**
 * Collects the stages of one traced request and submits the finished
 * `TraceEvent` to the active `TraceCollector` on `finish()`. Cheap when
 * tracing is disabled — callers gate construction on `settings.trace`.
 */
export class TraceSession {
  readonly id = newTraceId();
  private readonly startedAt = Date.now();
  private readonly event: TraceEvent;

  constructor(meta: TraceSessionMeta) {
    this.event = {
      id: this.id,
      timestamp: this.startedAt,
      organizationId: meta.organizationId,
      apiKeyId: meta.apiKeyId,
      provider: meta.provider,
      model: meta.model,
      stream: meta.stream,
    };
  }

  /** The raw client request body (already parsed JSON). */
  setInboundRequest(body: unknown): this {
    this.event.inboundRequest = capped(body);
    return this;
  }

  setUpstreamRequest(req: {
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): this {
    this.event.upstreamRequest = {
      endpoint: req.endpoint,
      method: req.method,
      headers: sanitizeHeaders(req.headers),
      body: capped(req.body),
    };
    return this;
  }

  setUpstreamResponse(res: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    chunksCount?: number;
    error?: unknown;
  }): this {
    this.event.upstreamResponse = {
      status: res.status,
      headers: sanitizeHeaders(res.headers),
      body: capped(res.body),
      chunksCount: res.chunksCount,
      error: res.error === undefined ? undefined : capped(res.error),
    };
    return this;
  }

  /** Append a raw streaming chunk (kept under the same size cap). */
  addUpstreamChunk(chunk: unknown, maxChunks = 50): this {
    const res = (this.event.upstreamResponse ??= {});
    const chunks =
      res.body && Array.isArray(res.body) ? (res.body as unknown[]) : [];
    if (chunks.length < maxChunks) chunks.push(capped(chunk));
    res.body = chunks;
    res.chunksCount = (res.chunksCount ?? 0) + 1;
    return this;
  }

  setOutboundResponse(body: unknown): this {
    this.event.outboundResponse = capped(body);
    return this;
  }

  /** Submit the finished event to the active collector. */
  async finish(): Promise<void> {
    this.event.latencyMs = Date.now() - this.startedAt;
    await getTraceCollector().record(this.event);
  }
}

export interface TextCaptureTransform {
  /** Pass-through stream that tees decoded text into the capture buffer. */
  stream: TransformStream<Uint8Array, Uint8Array>;
  /** Resolves with the captured text when the stream ends or is cancelled. */
  done: Promise<string>;
}

/**
 * Capture a streaming body's text for diagnostic purposes (size-capped).
 * Purely passive: chunks are forwarded unchanged.
 */
export function textCaptureTransform(
  capBytes = MAX_FIELD_BYTES,
): TextCaptureTransform {
  const decoder = new TextDecoder();
  let captured = "";
  let cappedOff = false;
  let resolveDone!: (text: string) => void;
  let settled = false;
  const done = new Promise<string>((resolve) => {
    resolveDone = (text) => {
      if (!settled) {
        settled = true;
        resolve(text);
      }
    };
  });
  const settle = () => resolveDone(captured);
  return {
    stream: new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!cappedOff) {
          captured += decoder.decode(chunk, { stream: true });
          if (captured.length > capBytes) {
            captured = captured.slice(0, capBytes) + TRUNCATION_MARKER;
            cappedOff = true;
          }
        }
      },
      flush() {
        settle();
      },
      cancel() {
        settle();
      },
    }),
    done,
  };
}
