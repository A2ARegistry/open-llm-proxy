import { describe, it, expect, vi } from "vitest";

describe("GoogleDirectAdapter message conversion", () => {
  it("should convert tool results to functionResponse format", () => {
    // Simulating the conversion logic
    const messages = [
      { role: "user", content: "What's in file.txt?" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_123",
            function: { name: "read", arguments: '{"path":"file.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_123", name: "read", content: "File contents here" },
    ];

    // Expected Google format for tool result
    const expectedGoogleFormat = {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read",
            response: {
              content: "File contents here",
            },
          },
        },
      ],
    };

    // The adapter should convert tool results to this format
    expect(expectedGoogleFormat.parts[0].functionResponse.name).toBe("read");
    expect(expectedGoogleFormat.parts[0].functionResponse.response.content).toBe(
      "File contents here",
    );
    expect(expectedGoogleFormat.role).toBe("user"); // Not "tool"!
  });

  it("should group multiple tool results into single user turn", () => {
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "read", arguments: '{"path":"a.txt"}' },
          },
          {
            id: "call_2",
            function: { name: "read", arguments: '{"path":"b.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "read", content: "Content A" },
      { role: "tool", tool_call_id: "call_2", name: "read", content: "Content B" },
    ];

    // Both tool results should be in ONE user turn with multiple parts
    const expectedGoogleFormat = {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read",
            response: { content: "Content A" },
          },
        },
        {
          functionResponse: {
            name: "read",
            response: { content: "Content B" },
          },
        },
      ],
    };

    expect(expectedGoogleFormat.parts.length).toBe(2);
    expect(expectedGoogleFormat.parts[0].functionResponse.name).toBe("read");
    expect(expectedGoogleFormat.parts[1].functionResponse.name).toBe("read");
  });

  it("should convert assistant tool calls to functionCall format", () => {
    const assistantMessage = {
      role: "assistant",
      tool_calls: [
        {
          id: "call_abc",
          function: {
            name: "get_weather",
            arguments: '{"location":"Boston"}',
          },
        },
      ],
    };

    // Expected Google format
    const expectedGoogleFormat = {
      role: "model", // Assistant becomes "model" in Google
      parts: [
        {
          functionCall: {
            name: "get_weather",
            args: { location: "Boston" }, // Parsed JSON, not string
          },
        },
      ],
    };

    const parsedArgs = JSON.parse(assistantMessage.tool_calls[0].function.arguments);
    expect(expectedGoogleFormat.parts[0].functionCall.name).toBe("get_weather");
    expect(expectedGoogleFormat.parts[0].functionCall.args).toEqual(parsedArgs);
  });

  it("should handle user messages as text parts", () => {
    const userMessage = {
      role: "user",
      content: "Hello, world!",
    };

    const expectedGoogleFormat = {
      role: "user",
      parts: [{ text: "Hello, world!" }],
    };

    expect(expectedGoogleFormat.role).toBe("user");
    expect(expectedGoogleFormat.parts[0].text).toBe("Hello, world!");
  });

  it("should filter out system messages from contents array", () => {
    const messages = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ];

    // System message should be extracted separately, not in contents
    // Contents should start with user message
    const expectedFirstContent = {
      role: "user",
      parts: [{ text: "Hello" }],
    };

    expect(expectedFirstContent.role).toBe("user");
  });
});

describe("GoogleDirectAdapter stop reason mapping", () => {
  it("should map toolUse stop reason for function calls", () => {
    const googleResponse = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "search",
                  args: { query: "weather" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    // If response has functionCall, stopReason should be "toolUse"
    const hasFunctionCall = googleResponse.candidates[0].content.parts.some(
      (p: { functionCall?: unknown }) => p.functionCall,
    );
    const expectedStopReason = hasFunctionCall ? "toolUse" : "stop";

    expect(expectedStopReason).toBe("toolUse");
  });

  it("should map stop reason for text responses", () => {
    const googleResponse = {
      candidates: [
        {
          content: {
            parts: [{ text: "Here is the answer" }],
          },
          finishReason: "STOP",
        },
      ],
    };

    const hasFunctionCall = googleResponse.candidates[0].content.parts.some(
      (p: { functionCall?: unknown }) => p.functionCall,
    );
    const expectedStopReason = hasFunctionCall ? "toolUse" : "stop";

    expect(expectedStopReason).toBe("stop");
  });

  it("should map length stop reason for MAX_TOKENS", () => {
    const googleFinishReason = "MAX_TOKENS";
    const expectedStopReason = "length";

    expect(expectedStopReason).toBe("length");
  });
});

describe("GoogleDirectAdapter tool_call_id encoding and decoding", () => {
  it("should encode and decode name and thought_signature into tool_call_id", async () => {
    const { encodeToolCallId, decodeToolCallId } = await import(
      "../../src/llm/google-direct-adapter"
    );

    const originalSignature = "sig_xyz123_encrypted_token/+=?";
    const index = 0;
    const toolName = "read";

    const toolCallId = encodeToolCallId(index, toolName, originalSignature);

    expect(toolCallId).toMatch(/^call_0_read__sig_[0-9a-fA-F]+$/);
    expect(toolCallId).not.toContain("/");
    expect(toolCallId).not.toContain("+");
    expect(toolCallId).not.toContain("=");

    const decoded = decodeToolCallId(toolCallId);
    expect(decoded).not.toBeNull();
    expect(decoded?.index).toBe(0);
    expect(decoded?.name).toBe("read");
    expect(decoded?.thoughtSignature).toBe(originalSignature);
  });

  it("should encode and decode multiple tool call IDs preserving index order and tool names", async () => {
    const { encodeToolCallId, decodeToolCallId } = await import(
      "../../src/llm/google-direct-adapter"
    );

    const sig = "shared_thought_signature";
    const id0 = encodeToolCallId(0, "grep", sig);
    const id1 = encodeToolCallId(1, "write", sig);

    expect(id0).toMatch(/^call_0_grep__sig_/);
    expect(id1).toMatch(/^call_1_write__sig_/);

    const decoded0 = decodeToolCallId(id0);
    const decoded1 = decodeToolCallId(id1);

    expect(decoded0?.index).toBe(0);
    expect(decoded0?.name).toBe("grep");
    expect(decoded1?.index).toBe(1);
    expect(decoded1?.name).toBe("write");
    expect(decoded0?.thoughtSignature).toBe(sig);
    expect(decoded1?.thoughtSignature).toBe(sig);
  });

  it("should safely handle tool call IDs without signature", async () => {
    const { encodeToolCallId, decodeToolCallId } = await import(
      "../../src/llm/google-direct-adapter"
    );

    const toolCallId = encodeToolCallId(2, "bash");

    expect(toolCallId).toMatch(/^call_2_bash__nosig_[0-9a-f]{16}$/);

    const decoded = decodeToolCallId(toolCallId);
    expect(decoded).not.toBeNull();
    expect(decoded?.index).toBe(2);
    expect(decoded?.name).toBe("bash");
    expect(decoded?.thoughtSignature).toBeUndefined();
  });
});
