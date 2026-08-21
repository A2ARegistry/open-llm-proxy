import { GoogleGenAI } from "@google/genai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { newUuid } from "../utils/crypto";

function stringToHex(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToString(hex: string): string {
  if (!hex || hex.length % 2 !== 0) return "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(bytes);
}

/**
 * Encode tool name and thought_signature into tool_call_id format:
 * call_<index>_<name>__sig_<hex_signature> or call_<index>_<name>__nosig_<randomHex>
 * This makes tool_call_id 100% self-contained and stateless.
 */
export function encodeToolCallId(
  index: number,
  name: string,
  thoughtSignature?: string,
): string {
  const sanitizedName = name ? name.replace(/[\s]/g, "_") : "tool";
  if (!thoughtSignature) {
    const randomHex = newUuid().replace(/-/g, "").slice(0, 16);
    return `call_${index}_${sanitizedName}__nosig_${randomHex}`;
  }
  const hexSignature = stringToHex(thoughtSignature);
  return `call_${index}_${sanitizedName}__sig_${hexSignature}`;
}

/**
 * Decode tool_call_id to extract index, tool name, and thought_signature.
 * Supports current call_<index>_<name>__sig_<hex> format as well as legacy formats.
 */
export function decodeToolCallId(toolCallId: string): {
  index: number;
  name?: string;
  thoughtSignature?: string;
} | null {
  if (!toolCallId) return null;

  // Format with signature: call_<index>_<name>__sig_<hexSignature>
  const sigMatch = toolCallId.match(/^call_(\d+)_(.+)__sig_([0-9a-fA-F]+)$/);
  if (sigMatch) {
    const index = parseInt(sigMatch[1], 10);
    const name = sigMatch[2];
    const hexSignature = sigMatch[3];
    try {
      const thoughtSignature = hexToString(hexSignature);
      if (thoughtSignature) {
        return { index, name, thoughtSignature };
      }
    } catch {
      // ignore
    }
    return { index, name };
  }

  // Format without signature: call_<index>_<name>__nosig_<randomHex>
  const noSigMatch = toolCallId.match(/^call_(\d+)_(.+)__nosig_([0-9a-fA-F]+)$/);
  if (noSigMatch) {
    return { index: parseInt(noSigMatch[1], 10), name: noSigMatch[2] };
  }

  // Legacy format with signature: call_<index>__sig_<hexSignature>
  const legacySigMatch = toolCallId.match(/^call_(\d+)__sig_([0-9a-fA-F]+)$/);
  if (legacySigMatch) {
    const index = parseInt(legacySigMatch[1], 10);
    const hexSignature = legacySigMatch[2];
    try {
      const thoughtSignature = hexToString(hexSignature);
      if (thoughtSignature) {
        return { index, thoughtSignature };
      }
    } catch {
      // ignore
    }
    return { index };
  }

  // Legacy format without signature: call_<index>_<randomHex>
  const legacyNoSigMatch = toolCallId.match(/^call_(\d+)_(.+)$/);
  if (legacyNoSigMatch) {
    return { index: parseInt(legacyNoSigMatch[1], 10) };
  }

  // Generic fallback: call_<index>
  const genericMatch = toolCallId.match(/^call_(\d+)/);
  if (genericMatch) {
    return { index: parseInt(genericMatch[1], 10) };
  }

  return null;
}

interface OpenAIMessage {
  role: string;
  content?: string | unknown[];
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    function: { name: string; arguments: string };
    thought_signature?: string;
  }[];
  name?: string;
}

interface GoogleContent {
  role: string;
  parts: GooglePart[];
}

interface GooglePart {
  text?: string;
  thought?: boolean | string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
  thoughtSignature?: string;
}

interface GoogleGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: GooglePart[];
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Direct Google Gemini/Vertex adapter that properly handles tool calls.
 * Uses 100% stateless tool_call_id encoding for name and thought_signature.
 */
export class GoogleDirectAdapter {
  private client: GoogleGenAI;

  constructor(config: { apiKey: string }) {
    console.log("[GoogleDirectAdapter] Initializing with API key (Express Mode)");
    this.client = new GoogleGenAI({
      vertexai: true,
      apiKey: config.apiKey,
    });
  }

  /**
   * Convert OpenAI format messages to Google's native format.
   * Tool name and thought_signature are recovered 100% statelessly from tool_call_id.
   */
  private convertMessagesToGoogleFormat(
    messages: OpenAIMessage[],
  ): GoogleContent[] {
    const contents: GoogleContent[] = [];
    let pendingToolParts: GooglePart[] = [];

    console.log(
      `[GoogleDirectAdapter] Converting ${messages.length} messages to Google format`,
    );

    for (let index = 0; index < messages.length; index++) {
      const msg = messages[index];

      // Handle tool results - pure stateless recovery of tool name from tool_call_id!
      if (msg.role === "tool") {
        const toolCallId = msg.tool_call_id ?? "";
        const decoded = decodeToolCallId(toolCallId);
        const toolName = msg.name || decoded?.name || "unknown_tool";

        const rawContent =
          typeof msg.content === "string"
            ? msg.content
            : String(msg.content ?? "");
        const contentSnippet =
          rawContent.length > 120
            ? rawContent.slice(0, 120) + "..."
            : rawContent;

        console.log(
          `[GoogleDirectAdapter] Converting tool result | toolCallId=${toolCallId} | toolName=${toolName} | contentSnippet=${JSON.stringify(contentSnippet)}`,
        );

        // ✅ CORRECT FORMAT: functionResponse with name and response wrapper
        pendingToolParts.push({
          functionResponse: {
            name: toolName,
            response: {
              content: rawContent,
            },
          },
        });

        // Check if next message is also a tool result
        const nextMsg = messages[index + 1];
        if (!nextMsg || nextMsg.role !== "tool") {
          // Flush all accumulated tool responses as a single user turn
          console.log(
            `[GoogleDirectAdapter] Flushing ${pendingToolParts.length} tool responses as user turn`,
          );
          contents.push({
            role: "user",
            parts: pendingToolParts,
          });
          pendingToolParts = [];
        }
        continue;
      }

      // Flush any pending tool parts (defensive)
      if (pendingToolParts.length > 0) {
        contents.push({
          role: "user",
          parts: pendingToolParts,
        });
        pendingToolParts = [];
      }

      // Handle user messages
      if (msg.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: typeof msg.content === "string" ? msg.content : "" }],
        });
        continue;
      }

      // Handle assistant messages
      if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          console.log(
            `[GoogleDirectAdapter] Assistant has tool_calls: count=${msg.tool_calls.length}`,
          );

          const parts: GooglePart[] = [];

          for (let idx = 0; idx < msg.tool_calls.length; idx++) {
            const tc = msg.tool_calls[idx];

            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch {
              args = {};
            }

            // 1. Direct signature from property
            let thoughtSignature = tc.thought_signature;

            // 2. Decode from tool_call_id (100% stateless recovery!)
            if (!thoughtSignature && tc.id) {
              const decoded = decodeToolCallId(tc.id);
              if (decoded?.thoughtSignature) {
                thoughtSignature = decoded.thoughtSignature;
                console.log(
                  `[GoogleDirectAdapter] Decoded thought_signature from tool_call_id for ${tc.function.name} | toolCallId=${tc.id}`,
                );
              }
            }

            console.log(
              `[GoogleDirectAdapter] Assistant tool_call ${idx} | name=${tc.function.name} | args=${tc.function.arguments} | toolCallId=${tc.id} | hasSig=${!!thoughtSignature}`,
            );

            const part: GooglePart = {
              functionCall: {
                name: tc.function.name,
                args,
              },
            };

            if (thoughtSignature) {
              part.thoughtSignature = thoughtSignature;
            }

            parts.push(part);
          }

          contents.push({
            role: "model",
            parts,
          });
        } else {
          // Regular text response
          contents.push({
            role: "model",
            parts: [{ text: typeof msg.content === "string" ? msg.content : "" }],
          });
        }
        continue;
      }

      // Skip system messages (handled separately)
      if (msg.role === "system") {
        continue;
      }
    }

    // Ensure conversation starts with user message
    while (contents.length > 0 && contents[0].role !== "user") {
      console.warn(
        "[GoogleDirectAdapter] Removing leading non-user message:",
        contents[0].role,
      );
      contents.shift();
    }

    console.log(
      `[GoogleDirectAdapter] Converted to ${contents.length} Google content entries`,
    );

    return contents;
  }

  /**
   * Extract system prompt from messages
   */
  private extractSystemPrompt(messages: OpenAIMessage[]): string | undefined {
    const systemMessages = messages.filter((m) => m.role === "system");
    if (systemMessages.length === 0) return undefined;

    return systemMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n\n");
  }

  /**
   * Convert Google response to AssistantMessage format
   */
  private convertToAssistantMessage(
    response: GoogleGenerateContentResponse,
    model: string,
  ): AssistantMessage {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new Error("No candidates returned from Google model");
    }

    const parts = candidate.content?.parts || [];
    const content: AssistantMessage["content"] = [];

    let hasToolCalls = false;
    let turnThoughtSignature: string | undefined;

    // First scan parts for any top-level or part thoughtSignature
    for (const part of parts) {
      if ((part as { thoughtSignature?: string }).thoughtSignature) {
        turnThoughtSignature = (part as { thoughtSignature?: string }).thoughtSignature;
      }
    }

    let toolCallIndex = 0;
    // Extract text, thinking, and function calls
    for (const part of parts) {
      const isThought = Boolean((part as { thought?: boolean | string }).thought);
      if (isThought) {
        const thoughtText =
          typeof (part as { thought?: boolean | string }).thought === "string"
            ? ((part as { thought?: string }).thought as string)
            : part.text || "";
        if (thoughtText) {
          content.push({ type: "thinking", thinking: thoughtText });
        }
      } else if (part.text) {
        content.push({ type: "text", text: part.text });
      }

      if (part.functionCall) {
        hasToolCalls = true;
        const sig = (part as { thoughtSignature?: string }).thoughtSignature || turnThoughtSignature;
        const toolCallId = encodeToolCallId(toolCallIndex, part.functionCall.name, sig);
        toolCallIndex++;

        const args = part.functionCall.args || {};
        console.log(
          `[GoogleDirectAdapter] Outgoing non-stream tool_call | name=${part.functionCall.name} | args=${JSON.stringify(args)} | toolCallId=${toolCallId}`,
        );

        const toolCall = {
          type: "toolCall" as const,
          id: toolCallId,
          name: part.functionCall.name,
          arguments: args,
        };

        if (sig) {
          (toolCall as { thought_signature?: string }).thought_signature = sig;
        }

        content.push(toolCall);
      }
    }

    // Determine stop reason
    let stopReason: AssistantMessage["stopReason"] = "stop";
    if (hasToolCalls) {
      stopReason = "toolUse";
    } else if (candidate.finishReason === "MAX_TOKENS") {
      stopReason = "length";
    }

    console.log(
      `[GoogleDirectAdapter] Response | stopReason=${stopReason} | hasToolCalls=${hasToolCalls} | hasThoughtSignature=${!!turnThoughtSignature} | finishReason=${candidate.finishReason}`,
    );

    return {
      role: "assistant",
      content,
      api: "google-generative-ai",
      provider: "google-vertex",
      model,
      usage: {
        input: response.usageMetadata?.promptTokenCount || 0,
        output: response.usageMetadata?.candidatesTokenCount || 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: response.usageMetadata?.totalTokenCount || 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
      responseId: `chatcmpl-${newUuid()}`,
    };
  }

  /**
   * Generate content using Google's native API (non-streaming)
   */
  async generateContent(input: {
    model: string;
    messages: OpenAIMessage[];
    tools?: Array<{
      type: string;
      function: {
        name: string;
        description?: string;
        parameters?: unknown;
      };
    }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<AssistantMessage> {
    const systemPrompt = this.extractSystemPrompt(input.messages);
    const contents = this.convertMessagesToGoogleFormat(input.messages);

    if (contents.length === 0) {
      throw new Error("Cannot process a conversation with no user messages");
    }

    const requestOptions: {
      model: string;
      contents: GoogleContent[];
      config: {
        temperature?: number;
        maxOutputTokens?: number;
        systemInstruction?: { parts: Array<{ text: string }> };
        tools?: Array<{
          functionDeclarations: Array<{
            name: string;
            description?: string;
            parameters?: unknown;
          }>;
        }>;
      };
    } = {
      model: input.model,
      contents,
      config: {
        temperature: input.temperature,
        maxOutputTokens: input.maxTokens,
      },
    };

    if (systemPrompt) {
      requestOptions.config.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    if (input.tools && input.tools.length > 0) {
      requestOptions.config.tools = [
        {
          functionDeclarations: input.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
      console.log(
        `[GoogleDirectAdapter] Attached ${input.tools.length} tool declarations`,
      );
    }

    console.log(
      `[GoogleDirectAdapter] Calling Google API | model=${input.model} | contents=${contents.length} | hasTools=${!!input.tools}`,
    );

    const response = (await this.client.models.generateContent(
      requestOptions,
    )) as GoogleGenerateContentResponse;

    return this.convertToAssistantMessage(response, input.model);
  }

  /**
   * Generate content using Google's native API (streaming)
   */
  async *streamGenerateContent(input: {
    model: string;
    messages: OpenAIMessage[];
    tools?: Array<{
      type: string;
      function: {
        name: string;
        description?: string;
        parameters?: unknown;
      };
    }>;
    temperature?: number;
    maxTokens?: number;
  }): AsyncIterable<AssistantMessageEvent> {
    const systemPrompt = this.extractSystemPrompt(input.messages);
    const contents = this.convertMessagesToGoogleFormat(input.messages);

    if (contents.length === 0) {
      throw new Error("Cannot process a conversation with no user messages");
    }

    const requestOptions: {
      model: string;
      contents: GoogleContent[];
      config: {
        temperature?: number;
        maxOutputTokens?: number;
        systemInstruction?: { parts: Array<{ text: string }> };
        tools?: Array<{
          functionDeclarations: Array<{
            name: string;
            description?: string;
            parameters?: unknown;
          }>;
        }>;
      };
    } = {
      model: input.model,
      contents,
      config: {
        temperature: input.temperature,
        maxOutputTokens: input.maxTokens,
      },
    };

    if (systemPrompt) {
      requestOptions.config.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    if (input.tools && input.tools.length > 0) {
      requestOptions.config.tools = [
        {
          functionDeclarations: input.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
      console.log(
        `[GoogleDirectAdapter] Attached ${input.tools.length} tool declarations`,
      );
    }

    console.log(
      `[GoogleDirectAdapter] Streaming from Google API | model=${input.model} | contents=${contents.length} | hasTools=${!!input.tools}`,
    );

    const stream = await this.client.models.generateContentStream(
      requestOptions,
    );

    let accumulatedContent: AssistantMessage["content"] = [];
    let usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    let currentTextIndex = -1;
    let currentThinkingIndex = -1;
    let currentToolIndex = -1;
    let lastThoughtSignature: string | undefined;
    const toolCallsById = new Map<string, number>();

    for await (const chunk of stream) {
      const candidate = (chunk as GoogleGenerateContentResponse).candidates?.[0];
      if (!candidate) continue;

      const parts = candidate.content?.parts || [];

      for (const part of parts) {
        if ((part as { thoughtSignature?: string }).thoughtSignature) {
          lastThoughtSignature = (part as { thoughtSignature?: string }).thoughtSignature;
        }

        const isThought = Boolean((part as { thought?: boolean | string }).thought);

        if (isThought) {
          const thoughtText =
            typeof (part as { thought?: boolean | string }).thought === "string"
              ? ((part as { thought?: string }).thought as string)
              : part.text || "";

          if (thoughtText) {
            if (
              currentThinkingIndex === -1 ||
              accumulatedContent[currentThinkingIndex]?.type !== "thinking"
            ) {
              currentThinkingIndex = accumulatedContent.length;
              accumulatedContent.push({ type: "thinking", thinking: "" });
              yield {
                type: "thinking_start",
                contentIndex: currentThinkingIndex,
                partial: {
                  role: "assistant",
                  content: accumulatedContent,
                  api: "google-generative-ai",
                  provider: "google-vertex",
                  model: input.model,
                  usage,
                  stopReason: "stop",
                  timestamp: Date.now(),
                },
              } as AssistantMessageEvent;
            }

            yield {
              type: "thinking_delta",
              contentIndex: currentThinkingIndex,
              delta: thoughtText,
              partial: {
                role: "assistant",
                content: accumulatedContent,
                api: "google-generative-ai",
                provider: "google-vertex",
                model: input.model,
                usage,
                stopReason: "stop",
                timestamp: Date.now(),
              },
            } as AssistantMessageEvent;

            (accumulatedContent[currentThinkingIndex] as { type: "thinking"; thinking: string }).thinking += thoughtText;
          }
        } else if (part.text) {
          // Check if we're continuing an existing text part or starting a new one
          if (currentTextIndex === -1 || 
              accumulatedContent[currentTextIndex]?.type !== "text") {
            // New text part
            currentTextIndex = accumulatedContent.length;
            accumulatedContent.push({ type: "text", text: "" });
          }

          // Emit delta
          yield {
            type: "text_delta",
            contentIndex: currentTextIndex,
            delta: part.text,
            partial: {
              role: "assistant",
              content: accumulatedContent,
              api: "google-generative-ai",
              provider: "google-vertex",
              model: input.model,
              usage,
              stopReason: "stop",
              timestamp: Date.now(),
            },
          } as AssistantMessageEvent;

          // Accumulate text
          (accumulatedContent[currentTextIndex] as { type: "text"; text: string }).text += part.text;
        }

        if (part.functionCall) {
          const args = (part.functionCall.args || {}) as Record<string, unknown>;
          const partSig =
            (part as { thoughtSignature?: string }).thoughtSignature ||
            lastThoughtSignature;

          let targetIndex = toolCallsById.get(part.functionCall.name);

          if (targetIndex === undefined) {
            // New tool call
            currentToolIndex = accumulatedContent.length;
            targetIndex = currentToolIndex;
            const toolCallCount = accumulatedContent.filter(
              (c) => c.type === "toolCall",
            ).length;
            const toolCallId = encodeToolCallId(
              toolCallCount,
              part.functionCall.name,
              partSig,
            );

            console.log(
              `[GoogleDirectAdapter] Outgoing stream tool_call | name=${part.functionCall.name} | args=${JSON.stringify(args)} | toolCallId=${toolCallId}`,
            );

            const toolCall: {
              type: "toolCall";
              id: string;
              name: string;
              arguments: Record<string, unknown>;
              thought_signature?: string;
            } = {
              type: "toolCall" as const,
              id: toolCallId,
              name: part.functionCall.name,
              arguments: args,
            };

            // ✅ CRITICAL: Preserve thought_signature from Google response
            if (partSig) {
              toolCall.thought_signature = partSig;
              console.log(
                `[GoogleDirectAdapter] Extracted thought_signature from Google response for ${part.functionCall.name} | toolCallId=${toolCallId}`,
              );
            }

            toolCallsById.set(part.functionCall.name, currentToolIndex);
            accumulatedContent.push(toolCall);

            yield {
              type: "toolcall_start",
              contentIndex: currentToolIndex,
              partial: {
                role: "assistant",
                content: accumulatedContent,
                api: "google-generative-ai",
                provider: "google-vertex",
                model: input.model,
                usage,
                stopReason: "toolUse",
                timestamp: Date.now(),
              },
            } as AssistantMessageEvent;

            yield {
              type: "toolcall_end",
              contentIndex: currentToolIndex,
              toolCall,
              partial: {
                role: "assistant",
                content: accumulatedContent,
                api: "google-generative-ai",
                provider: "google-vertex",
                model: input.model,
                usage,
                stopReason: "toolUse",
                timestamp: Date.now(),
              },
            } as AssistantMessageEvent;
          } else {
            // Existing tool call: merge arguments if new arguments received
            const existingCall = accumulatedContent[targetIndex] as {
              type: "toolCall";
              arguments: Record<string, unknown>;
            };
            if (Object.keys(args).length > 0) {
              existingCall.arguments = { ...existingCall.arguments, ...args };
              console.log(
                `[GoogleDirectAdapter] Merged args for stream tool_call | name=${part.functionCall.name} | args=${JSON.stringify(existingCall.arguments)}`,
              );
            }
          }
        }
      }

      // Update usage if available
      if ((chunk as GoogleGenerateContentResponse).usageMetadata) {
        const meta = (chunk as GoogleGenerateContentResponse).usageMetadata!;
        usage = {
          input: meta.promptTokenCount || 0,
          output: meta.candidatesTokenCount || 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: meta.totalTokenCount || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
    }

    // Determine final stop reason
    const hasToolCalls = accumulatedContent.some((c) => c.type === "toolCall");
    const stopReason: AssistantMessage["stopReason"] = hasToolCalls ? "toolUse" : "stop";

    console.log(
      `[GoogleDirectAdapter] Stream complete | stopReason=${stopReason} | ` +
      `hasToolCalls=${hasToolCalls} | hasThoughtSignature=${!!lastThoughtSignature}`,
    );

    // Send final done event
    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: accumulatedContent,
      api: "google-generative-ai",
      provider: "google-vertex",
      model: input.model,
      usage,
      stopReason,
      timestamp: Date.now(),
      responseId: `chatcmpl-${newUuid()}`,
    };

    yield {
      type: "done",
      reason: stopReason,
      message: finalMessage,
    } as AssistantMessageEvent;
  }
}
