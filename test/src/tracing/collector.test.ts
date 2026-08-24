import { describe, it, expect } from "vitest";
import {
  ConsoleTraceCollector,
  sanitizeHeaders,
  setTraceCollector,
  textCaptureTransform,
  TraceSession,
  type TraceCollector,
  type TraceEvent,
} from "~/src/tracing/collector";

describe("sanitizeHeaders", () => {
  it("redacts sensitive headers", () => {
    const out = sanitizeHeaders({
      authorization: "Bearer sk-secret",
      "x-goog-api-key": "AIza-secret",
      "content-type": "application/json",
    });
    expect(out).toEqual({
      authorization: "[REDACTED]",
      "x-goog-api-key": "[REDACTED]",
      "content-type": "application/json",
    });
  });

  it("returns undefined for undefined input", () => {
    expect(sanitizeHeaders(undefined)).toBeUndefined();
  });
});

describe("TraceSession", () => {
  it("collects stages and submits a complete event on finish", async () => {
    const events: TraceEvent[] = [];
    const collector: TraceCollector = {
      record(event) {
        events.push(event);
      },
    };
    setTraceCollector(collector);

    const session = new TraceSession({
      organizationId: "org_test",
      apiKeyId: "key_test",
      provider: "google-vertex",
      model: "gemini-test",
      stream: false,
    });
    session
      .setInboundRequest({ model: "google-vertex/gemini-test" })
      .setUpstreamRequest({
        endpoint: "https://upstream.example",
        method: "POST",
        headers: { authorization: "Bearer x" },
        body: { contents: [] },
      })
      .setUpstreamResponse({ status: 200, body: { ok: true } })
      .setOutboundResponse('{"id":"chatcmpl-x"}');
    await session.finish();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.organizationId).toBe("org_test");
    expect(event.upstreamRequest?.headers?.authorization).toBe("[REDACTED]");
    expect(event.upstreamResponse?.status).toBe(200);
    expect(typeof event.latencyMs).toBe("number");
  });

  it("addUpstreamChunk counts all chunks but stores only the first N", () => {
    const session = new TraceSession({
      organizationId: "org",
      provider: "p",
      model: "m",
      stream: true,
    });
    for (let i = 0; i < 60; i++) session.addUpstreamChunk({ i });
    const res = session["event"].upstreamResponse;
    expect(res?.chunksCount).toBe(60);
    expect((res?.body as unknown[]).length).toBe(50);
  });

  it("caps oversized fields with a truncation marker", () => {
    const session = new TraceSession({
      organizationId: "org",
      provider: "p",
      model: "m",
      stream: false,
    });
    session.setInboundRequest({ big: "x".repeat(1024 * 1024) });
    const stored = JSON.stringify(session["event"].inboundRequest);
    expect(stored.length).toBeLessThan(600 * 1024);
    expect(stored).toContain("[truncated]");
  });
});

describe("textCaptureTransform", () => {
  const src = (...parts: string[]) => new Blob(parts).stream();

  it("passes chunks through and resolves captured text on flush", async () => {
    const { stream, done } = textCaptureTransform();
    const out = src("data: one\n\n", "data: two\n\n").pipeThrough(stream);
    const passed = await new Response(out).text();
    expect(passed).toBe("data: one\n\ndata: two\n\n");
    await expect(done).resolves.toBe("data: one\n\ndata: two\n\n");
  });

  it("caps captured text at the configured limit", async () => {
    const { stream, done } = textCaptureTransform(16);
    const out = src("x".repeat(100)).pipeThrough(stream);
    await new Response(out).text();
    const text = await done;
    expect(text.startsWith("x".repeat(16))).toBe(true);
    expect(text.endsWith("[truncated]")).toBe(true);
  });

  it("resolves exactly once even when cancelled", async () => {
    const { stream, done } = textCaptureTransform();
    const out = src("partial").pipeThrough(stream);
    const reader = out.getReader();
    await reader.read();
    await reader.cancel();
    await expect(done).resolves.toBe("partial");
  });
});

describe("ConsoleTraceCollector", () => {
  it("emits without throwing for a fully populated event", () => {
    const collector = new ConsoleTraceCollector();
    expect(() =>
      collector.record({
        id: "trace_x",
        timestamp: Date.now(),
        organizationId: "org",
        provider: "openai",
        model: "gpt-test",
        stream: false,
        inboundRequest: { messages: [] },
        latencyMs: 5,
      }),
    ).not.toThrow();
  });
});
