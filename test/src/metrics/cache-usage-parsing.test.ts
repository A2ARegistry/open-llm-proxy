import { describe, it, expect } from "vitest";
import { googleUsageOf } from "~/src/llm/google-direct-adapter";
import {
  sseUsageOf,
  usageCapturingTransform,
} from "~/src/requests/chat_completions_v2";

const encoder = new TextEncoder();

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  await stream.pipeTo(
    new WritableStream({
      write(c) {
        void parts.push(c);
      },
    }),
  );
  return parts.map((p) => new TextDecoder().decode(p)).join("");
}

describe("sseUsageOf", () => {
  it("extracts usage from the final chunk of an OpenAI-compatible stream", () => {
    const text =
      `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":80}}}\n\n` +
      `data: [DONE]\n\n`;
    expect(sseUsageOf(text)).toEqual({
      input: 20, // 100 - 80 cached
      output: 5,
      cacheRead: 80,
      cacheWrite: 0,
    });
  });

  it("supports DeepSeek-style cache hit fields", () => {
    const text = `data: {"usage":{"prompt_tokens":50,"completion_tokens":3,"prompt_cache_hit_tokens":40,"prompt_cache_miss_tokens":10}}\n\n`;
    expect(sseUsageOf(text)).toEqual({
      input: 10,
      output: 3,
      cacheRead: 40,
      cacheWrite: 0,
    });
  });

  it("returns null when no chunk carries usage", () => {
    expect(sseUsageOf(`data: {"choices":[]}\n\ndata: [DONE]\n\n`)).toBeNull();
    expect(sseUsageOf("not sse at all")).toBeNull();
  });
});

describe("usageCapturingTransform", () => {
  it("passes bytes through untouched and records usage on flush", async () => {
    const chunks = [
      `data: {"choices":[{"delta":{"content":"He"}}]}\n\n`,
      `data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":2}}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const recorded: unknown[] = [];
    const out = await drain(
      sse(chunks).pipeThrough(usageCapturingTransform((u) => recorded.push(u))),
    );
    expect(out).toBe(chunks.join(""));
    expect(recorded).toEqual([
      { input: 30, output: 2, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it("records null exactly once when the stream is cancelled", async () => {
    const recorded: unknown[] = [];
    const stream = sse([
      `data: {"choices":[{"delta":{"content":"partial"}}]}\n\n`,
    ]).pipeThrough(usageCapturingTransform((u) => recorded.push(u)));
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    // Allow the cancel callback to settle.
    await Promise.resolve();
    expect(recorded).toEqual([null]);
  });
});

describe("googleUsageOf", () => {
  it("reports Gemini cached tokens as cacheRead and excludes them from input", () => {
    expect(
      googleUsageOf({
        promptTokenCount: 1000,
        candidatesTokenCount: 50,
        totalTokenCount: 1050,
        cachedContentTokenCount: 600,
      }),
    ).toEqual({
      input: 400,
      output: 50,
      cacheRead: 600,
      cacheWrite: 0,
      totalTokens: 1050,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("handles missing metadata", () => {
    expect(googleUsageOf({})).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
