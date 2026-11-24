// [fork] W3: provider-level request shaping (see FORK.md).

type Body = Record<string, unknown>;

function isObject(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge a provider's `settings.injectBody` into an outgoing chat body.
 *
 * The client's explicit values always win (`{ ...injectBody, ...body }`).
 * `stream_options` is deep-merged, and only on streaming requests, since
 * OpenAI-compatible servers reject it when `stream` is false.
 */
export function applyInjectBody(
  body: Body,
  injectBody: unknown,
  stream: boolean,
): Body {
  if (!isObject(injectBody) || Object.keys(injectBody).length === 0) {
    return body;
  }
  const { stream_options: injectedOptions, ...injected } = injectBody;
  const merged: Body = { ...injected, ...body };
  if (stream && isObject(injectedOptions)) {
    merged.stream_options = {
      ...injectedOptions,
      ...(isObject(body.stream_options) ? body.stream_options : {}),
    };
  }
  return merged;
}

const INJECT_BODY_MAX_BYTES = 4096;
const RESERVED_KEYS = ["model", "messages", "stream"];

/**
 * Validate a `settings.injectBody` value before it is saved.
 *
 * @throws Error when it is not a small JSON object, or sets a field the
 * gateway owns (`model`, `messages`, `stream`).
 */
export function validateInjectBody(value: unknown): void {
  if (!isObject(value)) {
    throw new Error("settings.injectBody must be a JSON object");
  }
  for (const key of RESERVED_KEYS) {
    if (key in value) {
      throw new Error(`settings.injectBody must not set ${key}`);
    }
  }
  if (JSON.stringify(value).length > INJECT_BODY_MAX_BYTES) {
    throw new Error(
      `settings.injectBody must be at most ${INJECT_BODY_MAX_BYTES} bytes`,
    );
  }
}
