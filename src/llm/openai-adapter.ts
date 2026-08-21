import { newUuid } from "../utils/crypto";
import {
  canonicalProviderName,
  isKnownProviderName,
} from "./provider-registry";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
} from "@earendil-works/pi-ai";

export interface ParsedModel {
  provider: string;
  model: string;
}

export function parseModelString(model: string): ParsedModel {
  const slash = model.indexOf("/");
  if (slash === -1) return { provider: "", model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

export function resolveModel(
  model: string,
  defaultModel: string | undefined,
): ParsedModel {
  const resolved = model === "default" ? (defaultModel ?? model) : model;
  return parseModelString(resolved);
}

/**
 * Resolve a raw request model string into a provider + model id, being tolerant
 * of missing/partial models so a per-provider default model can fill in:
 *
 * - `""`/missing/`"default"` → the tenant default model (provider + id).
 * - `"provider/model"` → that provider and model (id may be empty: `"provider/"`).
 * - `"provider"` (no slash) → that provider with an empty id (default fills in).
 * - any other bare id → the tenant default provider (if any) + that id.
 */
export function resolveRequestModel(input: {
  rawModel: string;
  tenantDefaultModel?: string;
}): ParsedModel {
  const tenant = input.tenantDefaultModel
    ? parseModelString(input.tenantDefaultModel)
    : undefined;
  const raw = input.rawModel.trim();
  if (!raw || raw === "default") {
    return { provider: tenant?.provider ?? "", model: tenant?.model ?? "" };
  }
  const parsed = parseModelString(raw);
  if (parsed.provider) {
    return {
      provider: canonicalProviderName(parsed.provider),
      model: parsed.model,
    };
  }
  if (isKnownProviderName(parsed.model)) {
    return { provider: canonicalProviderName(parsed.model), model: "" };
  }
  return { provider: tenant?.provider ?? "", model: parsed.model };
}

interface OpenAiMessage {
  role: string;
  content?: string | unknown[];
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  name?: string;
}

function makeTextContent(text: string) {
  return { type: "text" as const, text };
}

/** Convert an OpenAI chat-completions request body into a pi-ai Context. */
export function toPiContext(body: {
  model?: string;
  messages?: OpenAiMessage[];
  system_prompt?: string;
}): Context {
  const systemParts: string[] = [];
  const messages: Message[] = [];
  const toolNameById = new Map<string, string>();

  console.log(
    `[openai-adapter] toPiContext | model=${body.model} | ` +
    `messageCount=${body.messages?.length ?? 0}`
  );

  for (const msg of body.messages ?? []) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "";
      messages.push({
        role: "user",
        content,
        timestamp: Date.now(),
      });
      console.log(`[openai-adapter] toPiContext | role=user | contentLength=${content.length}`);
      continue;
    }
    if (msg.role === "assistant") {
      const parts: { type: "text"; text: string }[] = [];
      const toolCalls: {
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }[] = [];
      if (typeof msg.content === "string") {
        parts.push(
          ...msg.content.split(/(?<=\n)(?=\S)/).map((t) => makeTextContent(t)),
        );
      }
      for (const tc of msg.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        toolNameById.set(tc.id, tc.function.name);
        const toolCall: {
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
          thought_signature?: string;
        } = {
          type: "toolCall",
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        };
        // Preserve thought_signature if present (needed for Google Vertex continuation)
        if ((tc as { thought_signature?: string }).thought_signature) {
          toolCall.thought_signature = (tc as { thought_signature?: string }).thought_signature;
        }
        toolCalls.push(toolCall);
      }
      console.log(
        `[openai-adapter] toPiContext | role=assistant | toolCallsCount=${toolCalls.length}` +
        (toolCalls.length > 0 ? ` | toolNames=[${toolCalls.map(tc => tc.name).join(", ")}]` : "")
      );
      messages.push({
        role: "assistant",
        content: [...parts, ...toolCalls],
        api: "openai-completions",
        provider: "openai",
        model: body.model ?? "",
        usage: emptyUsage(),
        stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
        timestamp: Date.now(),
      } satisfies AssistantMessage);
      continue;
    }
    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id ?? "";
      const content =
        typeof msg.content === "string"
          ? msg.content
          : String(msg.content ?? "");
      console.log(
        `[openai-adapter] toPiContext | role=tool | toolCallId=${toolCallId} | ` +
        `toolName=${toolNameById.get(toolCallId) ?? msg.name ?? "tool"} | ` +
        `contentLength=${content.length}`
      );
      if (content) {
        messages.push({
          role: "toolResult",
          toolCallId,
          toolName: toolNameById.get(toolCallId) ?? msg.name ?? "tool",
          content: [makeTextContent(content)],
          isError: false,
          timestamp: Date.now(),
        } satisfies Message);
      }
    }
  }

  console.log(
    `[openai-adapter] toPiContext | finalMessageCount=${messages.length} | ` +
    `hasSystemPrompt=${systemParts.length > 0}`
  );

  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

export function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function finishReasonFromStop(
  stop: AssistantMessage["stopReason"],
): string {
  switch (stop) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "toolUse":
      return "tool_calls";
    case "error":
      return "error";
    case "aborted":
      return "content_filter";
    case "deferred":
      return "stop";
    default:
      return "stop";
  }
}

/** Convert a pi-ai AssistantMessage into an OpenAI chat completion object. */
export function assistantToOpenAI(
  message: AssistantMessage,
  requestModel: string,
): Record<string, unknown> {
  let content = "";
  const toolCalls: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }[] = [];

  for (const part of message.content) {
    if (part.type === "text") {
      content += (content ? "\n" : "") + part.text;
    } else if (part.type === "toolCall") {
      const toolCall: {
        id: string;
        type: string;
        function: { name: string; arguments: string };
        thought_signature?: string;
      } = {
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.arguments ?? {}),
        },
      };
      // Include thought_signature if present (Google Vertex requirement)
      if ((part as { thought_signature?: string }).thought_signature) {
        toolCall.thought_signature = (part as { thought_signature?: string }).thought_signature;
      }
      toolCalls.push(toolCall);
    }
  }

  const msg: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;

  // Fix for Google Gemini/Vertex: if we have tool calls, always return
  // finish_reason: "tool_calls", even if the upstream provider incorrectly
  // sent "stop". This ensures agentic workflows continue properly.
  const originalStopReason = message.stopReason;
  const mappedFinishReason = finishReasonFromStop(originalStopReason);
  const finishReason = toolCalls.length > 0
    ? "tool_calls"
    : mappedFinishReason;

  console.log(
    `[openai-adapter] assistantToOpenAI | model=${requestModel} | ` +
    `provider=${message.provider} | stopReason=${originalStopReason} | ` +
    `mappedFinishReason=${mappedFinishReason} | toolCallsCount=${toolCalls.length} | ` +
    `finalFinishReason=${finishReason}` +
    (toolCalls.length > 0 ? ` | toolNames=[${toolCalls.map(tc => tc.function.name).join(", ")}]` : "")
  );

  return {
    id: message.responseId ?? `chatcmpl-${newUuid()}`,
    object: "chat.completion",
    created: Math.floor((message.timestamp || Date.now()) / 1000),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: msg,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: message.usage.input,
      completion_tokens: message.usage.output,
      total_tokens: message.usage.totalTokens,
      prompt_tokens_details: {
        cached_tokens: message.usage.cacheRead,
      },
    },
  };
}

export function usageToOpenAI(usage: AssistantMessage["usage"]) {
  return {
    prompt_tokens: usage.input,
    completion_tokens: usage.output,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cacheRead,
    },
  };
}

function chunkBase(requestModel: string, responseId: string) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
  };
}

/** Convert a pi-ai AssistantMessageEvent into OpenAI chunk JSON (or null to skip). */
export function eventToOpenAIChunks(
  event: AssistantMessageEvent,
  requestModel: string,
  responseId: string,
  state: { emittedRole: boolean } = { emittedRole: false },
): string[] {
  const chunks: string[] = [];
  if (!state.emittedRole && event.type !== "error") {
    state.emittedRole = true;
    chunks.push(
      JSON.stringify({
        ...chunkBase(requestModel, responseId),
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  switch (event.type) {
    case "text_start":
      break;
    case "text_delta":
      chunks.push(
        JSON.stringify({
          ...chunkBase(requestModel, responseId),
          choices: [
            { index: 0, delta: { content: event.delta }, finish_reason: null },
          ],
        }),
      );
      break;
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
      break;
    case "toolcall_start": {
      const toolCall = event.partial.content[event.contentIndex];
      if (toolCall && toolCall.type === "toolCall") {
        const argsStr = JSON.stringify(toolCall.arguments ?? {});
        chunks.push(
          JSON.stringify({
            ...chunkBase(requestModel, responseId),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: event.contentIndex,
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.name,
                        arguments: argsStr === "{}" ? "" : argsStr,
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
        // If arguments were already present on toolCall, also emit arguments delta chunk
        if (argsStr !== "{}" && argsStr !== "") {
          chunks.push(
            JSON.stringify({
              ...chunkBase(requestModel, responseId),
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: event.contentIndex,
                        function: { arguments: argsStr },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
        }
      }
      break;
    }
    case "toolcall_delta":
      chunks.push(
        JSON.stringify({
          ...chunkBase(requestModel, responseId),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: event.contentIndex,
                    function: { arguments: event.delta },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      break;
    case "toolcall_end": {
      const toolCall = event.toolCall;
      chunks.push(
        JSON.stringify({
          ...chunkBase(requestModel, responseId),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: event.contentIndex,
                    id: toolCall.id,
                    type: "function",
                    function: {
                      name: toolCall.name,
                      arguments: JSON.stringify(toolCall.arguments ?? {}),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      break;
    }
    case "done": {
      // Fix for Google Gemini/Vertex: check if the message contains tool calls
      // and override finish_reason to "tool_calls" even if stopReason is "stop"
      const hasToolCalls = event.message.content.some(
        (part) => part.type === "toolCall",
      );
      const originalStopReason = event.message.stopReason;
      const mappedFinishReason = finishReasonFromStop(originalStopReason);
      const finishReason = hasToolCalls
        ? "tool_calls"
        : mappedFinishReason;
      
      const toolCallNames = event.message.content
        .filter((part) => part.type === "toolCall")
        .map((part) => (part as { name: string }).name);
      
      console.log(
        `[openai-adapter] streaming done | model=${requestModel} | ` +
        `stopReason=${originalStopReason} | mappedFinishReason=${mappedFinishReason} | ` +
        `hasToolCalls=${hasToolCalls} | finalFinishReason=${finishReason}` +
        (toolCallNames.length > 0 ? ` | toolNames=[${toolCallNames.join(", ")}]` : "")
      );
      
      chunks.push(
        JSON.stringify({
          ...chunkBase(requestModel, responseId),
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          usage: usageToOpenAI(event.message.usage),
        }),
      );
      break;
    }
    case "error":
      // If we have already streamed, the response terminates with [DONE];
      // otherwise surface a clean stop.
      console.log(
        `[openai-adapter] streaming error | model=${requestModel} | ` +
        `errorMessage=${event.error.errorMessage ?? "no error message"}`
      );
      chunks.push(
        JSON.stringify({
          ...chunkBase(requestModel, responseId),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: usageToOpenAI(event.error.usage),
        }),
      );
      break;
    default:
      break;
  }
  return chunks;
}

/** Serialize OpenAI chat completion chunks as SSE lines (text/event-stream body). */
export function encodeSse(chunks: string[]): string {
  return chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
}
