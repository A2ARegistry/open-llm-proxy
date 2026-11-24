/** Gateway-measured speed of one streamed reply, in wall-clock milliseconds. */
export interface StreamTimings {
  /** Request start -> first output delta (queue + prefill + network). */
  ttftMs: number | null;
  /** First output delta -> end of stream. Null when the stream did not complete. */
  decodeMs: number | null;
}

/** pi-ai stream events that carry model output (text, reasoning or tool calls). */
const OUTPUT_EVENT_TYPES = new Set([
  "text_delta",
  "thinking_delta",
  "toolcall_start",
  "toolcall_delta",
]);

/**
 * Times one streamed reply: when the first output token arrived and how long
 * the rest of the stream took. Feeds tokens/s and prefill figures in analytics.
 */
export class StreamTimer {
  private firstOutputAt: number | null = null;

  constructor(
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Marks the first output token. Later calls are ignored. */
  markFirstOutput(): void {
    if (this.firstOutputAt === null) this.firstOutputAt = this.now();
  }

  get hasFirstOutput(): boolean {
    return this.firstOutputAt !== null;
  }

  /** Marks the first output token when a pi-ai stream event carries output. */
  observeEvent(event: { type: string }): void {
    if (OUTPUT_EVENT_TYPES.has(event.type)) this.markFirstOutput();
  }

  /**
   * Final timings. `completed` false (client cancelled, upstream failed) keeps
   * the TTFT but drops decode time, which would understate the real duration.
   */
  finish(completed: boolean): StreamTimings {
    if (this.firstOutputAt === null) return { ttftMs: null, decodeMs: null };
    const ttftMs = Math.max(0, this.firstOutputAt - this.startedAt);
    if (!completed) return { ttftMs, decodeMs: null };
    return { ttftMs, decodeMs: Math.max(0, this.now() - this.firstOutputAt) };
  }
}
