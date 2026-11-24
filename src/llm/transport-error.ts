// [fork] W1: raised when a provider's transport cannot be resolved.

/** A provider asks for a transport the Worker is not configured to provide. */
export class TransportNotConfiguredError extends Error {
  readonly code = "not_configured";

  constructor(message: string) {
    super(message);
    this.name = "TransportNotConfiguredError";
  }
}
