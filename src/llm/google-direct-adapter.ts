import { newUuid } from "../utils/crypto";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { GoogleGenAI } from "@google/genai";

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
  const noSigMatch = toolCallId.match(
    /^call_(\d+)_(.+)__nosig_([0-9a-fA-F]+)$/,
  );
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
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  thought?: boolean;
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

/**
 * Helper to parse base64 image data from data URLs, raw base64 strings, or structured objects.
 */
function parseImageData(
  urlOrData: string,
): { mimeType: string; data: string } | null {
  if (!urlOrData) return null;

  if (urlOrData.startsWith("data:")) {
    const commaIdx = urlOrData.indexOf(",");
    if (commaIdx !== -1) {
      const header = urlOrData.slice(0, commaIdx);
      const data = urlOrData.slice(commaIdx + 1);
      const mimeTypeMatch = header.match(/^data:([^;]+)/);
      const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : "image/png";
      return { mimeType, data };
    }
  }

  const trimmed = urlOrData.trim();
  if (trimmed.startsWith("iVBORw0KGgo")) {
    return { mimeType: "image/png", data: trimmed };
  } else if (trimmed.startsWith("/9j/")) {
    return { mimeType: "image/jpeg", data: trimmed };
  } else if (trimmed.startsWith("R0lGOD")) {
    return { mimeType: "image/gif", data: trimmed };
  } else if (trimmed.startsWith("UklGR")) {
    return { mimeType: "image/webp", data: trimmed };
  } else if (trimmed.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return { mimeType: "image/png", data: trimmed.replace(/\s+/g, "") };
  }

  return null;
}

/**
 * Convert OpenAI user content (string or array of text/image parts) into Google parts.
 */
function convertUserContentToGoogleParts(
  content: string | unknown[] | undefined,
): GooglePart[] {
  if (!content) return [];

  if (typeof content === "string") {
    console.log(
      `[GoogleDirectAdapter] User string content (128b snippet):`,
      JSON.stringify(content.slice(0, 128)),
    );
    return content.trim().length > 0 ? [{ text: content }] : [];
  }

  if (Array.isArray(content)) {
    console.log(
      `[GoogleDirectAdapter] Processing array user content with ${content.length} items`,
    );

    const parts: GooglePart[] = [];
    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      console.log(
        `[GoogleDirectAdapter] Raw content item [${i}] (128b snippet):`,
        JSON.stringify(item).slice(0, 128),
      );

      if (typeof item === "string") {
        if (item.trim().length > 0) parts.push({ text: item });
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        console.log(
          `[GoogleDirectAdapter] Content item [${i}] | type=${obj.type} | keys=${Object.keys(obj).join(",")} | textSnippet=${typeof obj.text === "string" ? JSON.stringify(obj.text.slice(0, 100)) : undefined}`,
        );

        // 1. Text part
        if (
          (obj.type === "text" || !obj.type) &&
          typeof obj.text === "string" &&
          obj.text.trim().length > 0
        ) {
          parts.push({ text: obj.text });
        }
        // 2. OpenAI image_url format ({ type: "image_url", image_url: { url: "..." } })
        else if (obj.type === "image_url" || obj.image_url || obj.url) {
          const imgObj =
            typeof obj.image_url === "string"
              ? { url: obj.image_url }
              : (obj.image_url as { url?: string; b64_json?: string }) ||
                (typeof obj.url === "string" ? { url: obj.url } : {});

          const rawUrl = imgObj.url || imgObj.b64_json || "";
          const parsed = parseImageData(rawUrl);

          if (parsed) {
            console.log(
              `[GoogleDirectAdapter] ✅ Converted image_url part to inlineData | mimeType=${parsed.mimeType} | dataBytes=${parsed.data.length}`,
            );
            parts.push({ inlineData: parsed });
          } else {
            console.warn(
              `[GoogleDirectAdapter] ⚠️ Could not parse image_url payload snippet:`,
              JSON.stringify(rawUrl).slice(0, 100),
            );
            if (
              rawUrl.startsWith("http://") ||
              rawUrl.startsWith("https://") ||
              rawUrl.startsWith("file://")
            ) {
              parts.push({ text: `[Image File/URL: ${rawUrl}]` });
            }
          }
        }
        // 3. Anthropic style image format ({ type: "image", source: { type: "base64", media_type: "...", data: "..." } })
        else if (
          obj.type === "image" &&
          obj.source &&
          typeof obj.source === "object"
        ) {
          const src = obj.source as {
            type?: string;
            media_type?: string;
            data?: string;
          };
          const parsed = parseImageData(src.data || "");
          if (parsed) {
            console.log(
              `[GoogleDirectAdapter] ✅ Converted Anthropic image part to inlineData | mimeType=${parsed.mimeType} | dataBytes=${parsed.data.length}`,
            );
            parts.push({ inlineData: parsed });
          } else {
            console.warn(
              `[GoogleDirectAdapter] ⚠️ Could not parse Anthropic image source`,
            );
          }
        }
        // 4. Native Google inlineData format ({ inlineData: { mimeType: "...", data: "..." } })
        else if (obj.inlineData && typeof obj.inlineData === "object") {
          const inline = obj.inlineData as { mimeType?: string; data?: string };
          if (inline.data) {
            console.log(
              `[GoogleDirectAdapter] ✅ Preserved native inlineData part | mimeType=${inline.mimeType} | dataBytes=${inline.data.length}`,
            );
            parts.push({
              inlineData: {
                mimeType: inline.mimeType || "image/png",
                data: inline.data,
              },
            });
          }
        } else {
          console.log(
            `[GoogleDirectAdapter] Unhandled content object structure:`,
            Object.keys(obj),
          );
        }
      }
    }
    return parts;
  }

  return [];
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

      // Handle user messages (supporting text and multimodal images)
      if (msg.role === "user") {
        const userParts = convertUserContentToGoogleParts(msg.content);
        if (userParts.length > 0) {
          contents.push({
            role: "user",
            parts: userParts,
          });
        }
        continue;
      }

      // Handle assistant messages
      if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts: GooglePart[] = [];

          for (let idx = 0; idx < msg.tool_calls.length; idx++) {
            const tc = msg.tool_calls[idx];

            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || "{}");
            } catch {
              args = {};
            }

            // Recover thought_signature: first from property, then from encoded tool_call_id
            let thoughtSignature = tc.thought_signature;
            if (!thoughtSignature && tc.id) {
              const decoded = decodeToolCallId(tc.id);
              if (decoded?.thoughtSignature) {
                thoughtSignature = decoded.thoughtSignature;
              }
            }

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
          const text = typeof msg.content === "string" ? msg.content : "";
          if (text.trim().length > 0) {
            contents.push({
              role: "model",
              parts: [{ text }],
            });
          }
        }
        continue;
      }

      // Skip system messages (handled separately)
      if (msg.role === "system") {
        continue;
      }
    }

    // Log the tail of incoming OpenAI messages for debugging
    const tailMessages = messages.slice(-3);
    console.log(
      `[GoogleDirectAdapter] Input tail (${tailMessages.length}/${messages.length}):`,
      JSON.stringify(
        tailMessages.map((m) => ({
          role: m.role,
          contentSnippet:
            typeof m.content === "string" ? m.content.slice(0, 50) : undefined,
          hasToolCalls: !!(m.tool_calls && m.tool_calls.length > 0),
          toolCallId: m.tool_call_id
            ? m.tool_call_id.slice(0, 30) + "..."
            : undefined,
        })),
      ),
    );

    // Ensure conversation starts with user message
    while (contents.length > 0 && contents[0].role !== "user") {
      console.warn(
        "[GoogleDirectAdapter] Removing leading non-user message:",
        contents[0].role,
      );
      contents.shift();
    }

    // Google API requires the conversation to end with a user turn.
    // This happens when the client sends full history ending with an
    // assistant text message (common in agentic tool-use flows).
    while (
      contents.length > 0 &&
      contents[contents.length - 1].role !== "user"
    ) {
      console.warn(
        "[GoogleDirectAdapter] Removing trailing non-user message:",
        contents[contents.length - 1].role,
      );
      contents.pop();
    }

    const tailContents = contents.slice(-3);
    console.log(
      `[GoogleDirectAdapter] Converted ${messages.length} messages to ${contents.length} Google content entries. Final tail:`,
      JSON.stringify(
        tailContents.map((c) => ({
          role: c.role,
          partKinds: c.parts.map((p) => {
            if (p.text) return "text";
            if (p.inlineData) return `inlineData:${p.inlineData.mimeType}`;
            if (p.functionCall) return `funcCall:${p.functionCall.name}`;
            if (p.functionResponse)
              return `funcResp:${p.functionResponse.name}`;
            return "unknown";
          }),
        })),
      ),
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
        turnThoughtSignature = (part as { thoughtSignature?: string })
          .thoughtSignature;
      }
    }

    let toolCallIndex = 0;
    // Extract text, thinking, and function calls
    for (const part of parts) {
      const isThought = Boolean(
        (part as { thought?: boolean | string }).thought,
      );
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
        const sig =
          (part as { thoughtSignature?: string }).thoughtSignature ||
          turnThoughtSignature;
        const toolCallId = encodeToolCallId(
          toolCallIndex,
          part.functionCall.name,
          sig,
        );
        toolCallIndex++;

        const args = part.functionCall.args || {};

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
        thinkingConfig?: { includeThoughts?: boolean };
        systemInstruction?: { parts: Array<{ text: string }> };
        tools?: Array<{
          functionDeclarations: Array<{
            name: string;
            description?: string;
            parameters?: any;
          }>;
        }>;
      };
    } = {
      model: input.model,
      contents,
      config: {
        temperature: input.temperature,
        maxOutputTokens: input.maxTokens,
        thinkingConfig: { includeThoughts: true },
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
            parameters: t.function.parameters as any,
          })),
        },
      ] as any;
    }

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
        thinkingConfig?: { includeThoughts?: boolean };
        systemInstruction?: { parts: Array<{ text: string }> };
        tools?: Array<{
          functionDeclarations: Array<{
            name: string;
            description?: string;
            parameters?: any;
          }>;
        }>;
      };
    } = {
      model: input.model,
      contents,
      config: {
        temperature: input.temperature,
        maxOutputTokens: input.maxTokens,
        thinkingConfig: { includeThoughts: true },
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
            parameters: t.function.parameters as any,
          })),
        },
      ] as any;
    }

    const stream =
      await this.client.models.generateContentStream(requestOptions);

    const accumulatedContent: AssistantMessage["content"] = [];
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
      const candidate = (chunk as GoogleGenerateContentResponse)
        .candidates?.[0];
      if (!candidate) continue;

      const parts = candidate.content?.parts || [];

      for (const part of parts) {
        if ((part as { thoughtSignature?: string }).thoughtSignature) {
          lastThoughtSignature = (part as { thoughtSignature?: string })
            .thoughtSignature;
        }

        const isThought = Boolean(
          (part as { thought?: boolean | string }).thought,
        );

        if (isThought) {
          const thoughtText =
            typeof (part as { thought?: boolean | string }).thought === "string"
              ? ((part as { thought?: string }).thought as string)
              : part.text || "";

          if (thoughtText) {
            console.log(
              `[GoogleDirectAdapter] Gemini thought delta (${thoughtText.length}b): ${JSON.stringify(thoughtText.slice(0, 30))}`,
            );

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

            (
              accumulatedContent[currentThinkingIndex] as {
                type: "thinking";
                thinking: string;
              }
            ).thinking += thoughtText;
          }
        } else if (part.text) {
          // Check if we're continuing an existing text part or starting a new one
          if (
            currentTextIndex === -1 ||
            accumulatedContent[currentTextIndex]?.type !== "text"
          ) {
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
          (
            accumulatedContent[currentTextIndex] as {
              type: "text";
              text: string;
            }
          ).text += part.text;
        }

        if (part.functionCall) {
          const args = (part.functionCall.args || {}) as Record<
            string,
            unknown
          >;
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
              `[GoogleDirectAdapter] Outgoing stream tool_call | name=${part.functionCall.name} | args=${JSON.stringify(args)} | toolCallId=${toolCallId.slice(0, 30)}...`,
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
    const stopReason: AssistantMessage["stopReason"] = hasToolCalls
      ? "toolUse"
      : "stop";

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
