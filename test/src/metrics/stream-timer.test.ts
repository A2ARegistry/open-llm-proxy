import { describe, it, expect } from "vitest";
import { StreamTimer } from "~/src/metrics/stream-timer";

function clock(...times: number[]): () => number {
  return () => {
    const next = times.shift();
    if (next === undefined) throw new Error("clock exhausted");
    return next;
  };
}

describe("StreamTimer", () => {
  it("measures TTFT from start and decode time from the first output", () => {
    const timer = new StreamTimer(1_000, clock(1_400, 3_400));
    expect(timer.hasFirstOutput).toBe(false);
    timer.markFirstOutput();
    expect(timer.hasFirstOutput).toBe(true);
    expect(timer.finish(true)).toEqual({ ttftMs: 400, decodeMs: 2_000 });
  });

  it("keeps the first mark and ignores later ones", () => {
    const timer = new StreamTimer(0, clock(100, 900));
    timer.markFirstOutput();
    timer.markFirstOutput();
    expect(timer.finish(true)).toEqual({ ttftMs: 100, decodeMs: 800 });
  });

  it("drops decode time when the stream did not complete", () => {
    const timer = new StreamTimer(0, clock(250));
    timer.markFirstOutput();
    expect(timer.finish(false)).toEqual({ ttftMs: 250, decodeMs: null });
  });

  it("reports nothing when no output arrived", () => {
    const timer = new StreamTimer(0, clock());
    expect(timer.finish(true)).toEqual({ ttftMs: null, decodeMs: null });
  });

  it("never reports negative durations", () => {
    const timer = new StreamTimer(500, clock(400, 300));
    timer.markFirstOutput();
    expect(timer.finish(true)).toEqual({ ttftMs: 0, decodeMs: 0 });
  });

  it("marks output only for pi-ai events that carry output", () => {
    for (const type of [
      "text_delta",
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
    ]) {
      const timer = new StreamTimer(0, clock(10));
      timer.observeEvent({ type });
      expect(timer.hasFirstOutput).toBe(true);
    }
    const idle = new StreamTimer(0, clock());
    for (const type of ["start", "text_start", "thinking_start", "done"]) {
      idle.observeEvent({ type });
    }
    expect(idle.hasFirstOutput).toBe(false);
  });

  it("uses the real clock by default", () => {
    const timer = new StreamTimer(Date.now());
    timer.markFirstOutput();
    const t = timer.finish(true);
    expect(t.ttftMs).toBeGreaterThanOrEqual(0);
    expect(t.decodeMs).toBeGreaterThanOrEqual(0);
  });
});
