import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { describe, it, expect } from "vitest";
import {
  assistantToOpenAI,
  encodeSse,
  eventToOpenAIChunks,
  parseModelString,
  resolveModel,
  resolveRequestModel,
  toPiContext,
} from "~/src/llm/openai-adapter";

function baseAssistant(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("parseModelString / resolveModel", () => {
  it("splits provider/model", () => {
    expect(parseModelString("openai/gpt-4o-mini")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("keeps bare ids with empty provider", () => {
    expect(parseModelString("gpt-4o-mini")).toEqual({
      provider: "",
      model: "gpt-4o-mini",
    });
  });

  it("substitutes default model", () => {
    expect(resolveModel("default", "openai/gpt-4o")).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });
});

describe("resolveRequestModel", () => {
  it("uses the tenant default when the model is missing or 'default'", () => {
    expect(
      resolveRequestModel({
        rawModel: "",
        tenantDefaultModel: "openai/gpt-4o",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(
      resolveRequestModel({
        rawModel: "default",
        tenantDefaultModel: "openai/gpt-4o",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("canonicalizes provider/model strings", () => {
    expect(
      resolveRequestModel({ rawModel: "google-ai-studio/gemini-2.5-flash" }),
    ).toEqual({
      provider: "google-ai-studio",
      model: "gemini-2.5-flash",
    });
    expect(
      resolveRequestModel({ rawModel: "google/gemini-2.5-flash" }),
    ).toEqual({
      provider: "google-ai-studio",
      model: "gemini-2.5-flash",
    });
    expect(
      resolveRequestModel({ rawModel: "google-vertex/gemini-2.5-pro" }),
    ).toEqual({
      provider: "google-vertex",
      model: "gemini-2.5-pro",
    });
    expect(resolveRequestModel({ rawModel: "xai/grok-4.6" })).toEqual({
      provider: "grok",
      model: "grok-4.6",
    });
  });

  it("turns a provider-only string into a provider with an empty model", () => {
    expect(resolveRequestModel({ rawModel: "anthropic" })).toEqual({
      provider: "anthropic",
      model: "",
    });
    expect(resolveRequestModel({ rawModel: "google-ai-studio" })).toEqual({
      provider: "google-ai-studio",
      model: "",
    });
    expect(resolveRequestModel({ rawModel: "google" })).toEqual({
      provider: "google-ai-studio",
      model: "",
    });
    expect(resolveRequestModel({ rawModel: "xai" })).toEqual({
      provider: "grok",
      model: "",
    });
  });

  it("resolves a bare id against the tenant default provider", () => {
    expect(
      resolveRequestModel({
        rawModel: "gpt-5",
        tenantDefaultModel: "openai/gpt-4o",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
  });
});

describe("toPiContext", () => {
  it("extracts system + user + assistant + tool messages", () => {
    const context = toPiContext({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Be terse" },
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "42" },
      ],
    });

    expect(context.systemPrompt).toBe("Be terse");
    expect(context.messages.length).toBe(3);
    const [user, assistant, tool] = context.messages;
    expect(user.role).toBe("user");
    expect((user as { content: string }).content).toBe("Hi");
    expect(assistant.role).toBe("assistant");
    const calls = (assistant as { content: unknown[] }).content.filter(
      (c) => (c as { type: string }).type === "toolCall",
    );
    expect(calls).toHaveLength(1);
    expect(tool.role).toBe("toolResult");
    const toolResult = tool as {
      toolCallId: string;
      toolName: string;
      content: { text: string }[];
    };
    expect(toolResult.toolCallId).toBe("call_1");
    expect(toolResult.toolName).toBe("lookup");
    expect(toolResult.content[0].text).toBe("42");
  });

  it("omits empty tool results", () => {
    const context = toPiContext({
      messages: [{ role: "tool", tool_call_id: "call_2", content: "" }],
    });
    expect(context.messages).toHaveLength(0);
  });
});

describe("assistantToOpenAI", () => {
  it("maps text + usage + finish reason", () => {
    const out = assistantToOpenAI(baseAssistant(), "openai/gpt-4o-mini");
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("Hello");
    expect(out.choices[0].finish_reason).toBe("stop");
    expect(out.usage.prompt_tokens).toBe(10);
    expect(out.usage.completion_tokens).toBe(5);
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(3);
  });

  it("maps tool calls and tool-use finish reason", () => {
    const message = baseAssistant({
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "lookup",
          arguments: { q: "x" },
        },
      ],
      stopReason: "toolUse",
    });
    const out = assistantToOpenAI(message, "m");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe(
      '{"q":"x"}',
    );
  });

  it("fixes Google Gemini/Vertex issue: uses tool_calls finish_reason when tool calls present even if stopReason is stop", () => {
    // Google Gemini/Vertex incorrectly returns stopReason: "stop" when there are tool calls
    // We need to detect this and override to "tool_calls" for agentic workflows to work
    const message = baseAssistant({
      content: [
        {
          type: "toolCall",
          id: "call_gemini_1",
          name: "get_weather",
          arguments: { location: "San Francisco" },
        },
      ],
      stopReason: "stop", // Incorrectly returned by Google as "stop"
    });
    const out = assistantToOpenAI(message, "google-vertex/gemini-2.0-flash");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.choices[0].message.tool_calls).toHaveLength(1);
    expect(out.choices[0].message.tool_calls[0].function.name).toBe(
      "get_weather",
    );
  });
});

describe("eventToOpenAIChunks / encodeSse", () => {
  const requestModel = "openai/gpt-4o-mini";
  const responseId = "chatcmpl-abc";

  it("emits role header then content deltas then a done chunk", () => {
    const state = { emittedRole: false };
    const textDelta = {
      type: "text_delta",
      contentIndex: 0,
      delta: "Hello",
      partial: baseAssistant(),
    } as unknown as AssistantMessageEvent;
    const done = {
      type: "done",
      reason: "stop",
      message: baseAssistant({ content: [{ type: "text", text: "Hello" }] }),
    } as unknown as AssistantMessageEvent;

    const all = [
      ...eventToOpenAIChunks(textDelta, requestModel, responseId, state),
      ...eventToOpenAIChunks(done, requestModel, responseId, state),
    ];
    expect(all).toHaveLength(3);
    const [role, delta, final] = all.map((c) => JSON.parse(c));
    expect(role.choices[0].delta.role).toBe("assistant");
    expect(delta.choices[0].delta.content).toBe("Hello");
    expect(final.choices[0].finish_reason).toBe("stop");
    expect(final.usage.prompt_tokens).toBe(10);
  });

  it("serializes SSE including [DONE]", () => {
    const sse = encodeSse(['{"a":1}']);
    expect(sse).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  });

  it("fixes Google Gemini streaming: uses tool_calls finish_reason when tool calls present even if stopReason is stop", () => {
    // Test the streaming fix for Google Gemini/Vertex
    const state = { emittedRole: false };
    const toolcallStart = {
      type: "toolcall_start",
      contentIndex: 0,
      partial: baseAssistant({
        content: [
          {
            type: "toolCall",
            id: "call_gemini_stream",
            name: "search",
            arguments: {},
          },
        ],
      }),
    } as unknown as AssistantMessageEvent;
    const done = {
      type: "done",
      reason: "stop", // Google incorrectly sends "stop" here
      message: baseAssistant({
        content: [
          {
            type: "toolCall",
            id: "call_gemini_stream",
            name: "search",
            arguments: { query: "weather" },
          },
        ],
        stopReason: "stop", // Incorrectly returned by Google
      }),
    } as unknown as AssistantMessageEvent;

    const chunks = [
      ...eventToOpenAIChunks(toolcallStart, requestModel, responseId, state),
      ...eventToOpenAIChunks(done, requestModel, responseId, state),
    ];

    const finalChunk = JSON.parse(chunks[chunks.length - 1]);
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");
  });
});
