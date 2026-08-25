import { describe, it, expect } from "vitest";
import {
  upstreamErrorInfo,
  upstreamErrorResponse,
} from "~/src/requests/chat_completions_v2";

const GENAI_429_MESSAGE = JSON.stringify({
  error: {
    code: 429,
    message: "Resource has been exhausted (e.g. check quota).",
    status: "RESOURCE_EXHAUSTED",
  },
});

describe("upstreamErrorInfo", () => {
  it("parses @google/genai ApiError (numeric status + JSON body message)", () => {
    const err = Object.assign(new Error(GENAI_429_MESSAGE), { status: 429 });
    const info = upstreamErrorInfo(err);
    expect(info.status).toBe(429);
    expect(info.code).toBe("RESOURCE_EXHAUSTED");
    expect(info.message).toBe(
      "Resource has been exhausted (e.g. check quota).",
    );
  });

  it("passes through plain Error messages without a status", () => {
    const info = upstreamErrorInfo(new Error("socket hang up"));
    expect(info.status).toBeUndefined();
    expect(info.code).toBeUndefined();
    expect(info.message).toBe("socket hang up");
  });

  it("ignores non-4xx/5xx status values", () => {
    const err = Object.assign(new Error("weird"), { status: 200 });
    expect(upstreamErrorInfo(err).status).toBeUndefined();
  });

  it("truncates very long messages", () => {
    const info = upstreamErrorInfo(new Error("x".repeat(1000)));
    expect(info.message.length).toBe(301);
    expect(info.message.endsWith("…")).toBe(true);
  });

  it("handles non-Error values", () => {
    const info = upstreamErrorInfo(undefined);
    expect(info.status).toBeUndefined();
    expect(info.message).toBe("unknown error");
  });
});

describe("upstreamErrorResponse", () => {
  it("maps upstream 429 to a 429 with Retry-After and rate_limit type", async () => {
    const res = upstreamErrorResponse({
      status: 429,
      code: "RESOURCE_EXHAUSTED",
      message: "Resource has been exhausted.",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    const body = (await res.json()) as { error: Record<string, string> };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain("RESOURCE_EXHAUSTED");
  });

  it("treats RESOURCE_EXHAUSTED as rate limit even without a status", () => {
    const res = upstreamErrorResponse({
      code: "RESOURCE_EXHAUSTED",
      message: "exhausted",
    });
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("passes through upstream 5xx status as upstream_error", () => {
    const res = upstreamErrorResponse({ status: 503, message: "overloaded" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("falls back to 500 when no status is known", () => {
    const res = upstreamErrorResponse({ message: "mystery failure" });
    expect(res.status).toBe(500);
  });
});
