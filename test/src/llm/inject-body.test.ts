// [fork] W3: provider-level request shaping.
import { describe, expect, it } from "vitest";
import { applyInjectBody } from "~/src/llm/inject-body";

describe("applyInjectBody", () => {
  it("returns the body unchanged when nothing is injected", () => {
    const body = { model: "m", messages: [] };
    expect(applyInjectBody(body, undefined, false)).toBe(body);
    expect(applyInjectBody(body, {}, false)).toEqual(body);
  });

  it("adds injected fields the client did not send", () => {
    expect(
      applyInjectBody({ messages: [] }, { return_progress: true }, false),
    ).toEqual({ messages: [], return_progress: true });
  });

  it("lets the client's explicit value win", () => {
    expect(
      applyInjectBody(
        { return_progress: false, temperature: 0.2 },
        { return_progress: true, temperature: 1 },
        false,
      ),
    ).toEqual({ return_progress: false, temperature: 0.2 });
  });

  it("deep-merges stream_options on streaming requests, client wins", () => {
    expect(
      applyInjectBody(
        { stream: true, stream_options: { include_usage: false, x: 1 } },
        { stream_options: { include_usage: true, y: 2 } },
        true,
      ),
    ).toEqual({
      stream: true,
      stream_options: { include_usage: false, x: 1, y: 2 },
    });
  });

  it("injects stream_options when the streaming client sent none", () => {
    expect(
      applyInjectBody(
        { stream: true },
        { stream_options: { include_usage: true } },
        true,
      ),
    ).toEqual({ stream: true, stream_options: { include_usage: true } });
  });

  it("never injects stream_options into a non-streaming request", () => {
    expect(
      applyInjectBody(
        { messages: [] },
        { stream_options: { include_usage: true }, return_progress: true },
        false,
      ),
    ).toEqual({ messages: [], return_progress: true });
  });

  it("keeps a client's own stream_options on a non-streaming request", () => {
    expect(
      applyInjectBody(
        { stream_options: { include_usage: true } },
        { stream_options: { y: 2 } },
        false,
      ),
    ).toEqual({ stream_options: { include_usage: true } });
  });
});
