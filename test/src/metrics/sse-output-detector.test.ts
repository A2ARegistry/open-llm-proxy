import { describe, it, expect } from "vitest";
import { SseOutputDetector } from "~/src/metrics/sse-output-detector";

const line = (payload: unknown) => `data: ${JSON.stringify(payload)}`;

describe("SseOutputDetector.isOutputLine", () => {
  it("counts content, reasoning, tool calls and legacy text", () => {
    for (const payload of [
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { reasoning_content: "thinking" } }] },
      { choices: [{ delta: { reasoning: "thinking" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0 }] } }] },
      { choices: [{ text: "legacy" }] },
    ]) {
      expect(SseOutputDetector.isOutputLine(line(payload))).toBe(true);
    }
  });

  it("ignores keepalives, role-only deltas, progress and garbage", () => {
    for (const raw of [
      ": keepalive",
      "",
      "data:",
      "data: [DONE]",
      "data: {not json",
      line({ usage: { prompt_tokens: 3 } }),
      line({ choices: [], prompt_progress: { processed: 10, total: 100 } }),
      line({ choices: [{ delta: { role: "assistant", content: "" } }] }),
      line({ choices: [{ delta: { tool_calls: [] } }] }),
      line({ choices: [{ finish_reason: "stop" }] }),
      line({ choices: [null] }),
      "event: ping",
    ]) {
      expect(SseOutputDetector.isOutputLine(raw)).toBe(false);
    }
  });
});

describe("SseOutputDetector.feed", () => {
  it("finds output split across chunks and stays true afterwards", () => {
    const detector = new SseOutputDetector();
    expect(detector.feed(": keepalive\n\n")).toBe(false);
    expect(detector.feed('data: {"choices":[{"delta":{"con')).toBe(false);
    expect(detector.feed('tent":"Hi"}}]}\r\n\r\n')).toBe(true);
    expect(detector.feed("anything")).toBe(true);
  });

  it("drops an oversized partial line instead of growing without bound", () => {
    const detector = new SseOutputDetector();
    expect(detector.feed(`data: ${"x".repeat(300 * 1024)}`)).toBe(false);
    // The dropped prefix cannot join with what follows into a valid line.
    expect(detector.feed('"}\n\n')).toBe(false);
    expect(
      detector.feed(`${line({ choices: [{ delta: { content: "ok" } }] })}\n`),
    ).toBe(true);
  });
});
