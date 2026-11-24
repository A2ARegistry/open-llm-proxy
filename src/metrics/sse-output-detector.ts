/** Longest partial line kept between chunks while waiting for a newline. */
const MAX_PENDING_CHARS = 256 * 1024;

interface StreamChoice {
  text?: unknown;
  delta?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    tool_calls?: unknown;
  };
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function choiceHasOutput(choice: StreamChoice): boolean {
  const delta = choice.delta;
  if (delta) {
    if (
      nonEmptyString(delta.content) ||
      nonEmptyString(delta.reasoning_content) ||
      nonEmptyString(delta.reasoning)
    ) {
      return true;
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      return true;
    }
  }
  return nonEmptyString(choice.text);
}

/**
 * Watches raw OpenAI-compatible SSE text and reports when the first chunk with
 * model output (content, reasoning or tool call) arrives. Keepalive comments,
 * role-only deltas and `prompt_progress` chunks (empty `choices`) do not count,
 * so prefill is not mistaken for output.
 */
export class SseOutputDetector {
  private pending = "";
  private found = false;

  /** Feeds decoded stream text. Returns true once output has been seen. */
  feed(text: string): boolean {
    if (this.found) return true;
    this.pending += text;
    const lines = this.pending.split("\n");
    // split() always returns at least one element: the trailing partial line.
    this.pending = lines.pop() as string;
    if (this.pending.length > MAX_PENDING_CHARS) this.pending = "";
    for (const line of lines) {
      if (SseOutputDetector.isOutputLine(line)) {
        this.found = true;
        this.pending = "";
        return true;
      }
    }
    return false;
  }

  /** True when one SSE line is a `data:` chunk carrying model output. */
  static isOutputLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return false;
    try {
      const parsed = JSON.parse(payload) as { choices?: unknown };
      if (!Array.isArray(parsed.choices)) return false;
      return (parsed.choices as StreamChoice[]).some(
        (c) => c !== null && typeof c === "object" && choiceHasOutput(c),
      );
    } catch {
      return false;
    }
  }
}
