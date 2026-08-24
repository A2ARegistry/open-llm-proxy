/**
 * Base-URL resolution helpers.
 *
 * The public repo ships placeholder URLs (`https://your-domain.com`) in
 * wrangler vars. When operators haven't configured their real URL yet, the
 * app should fall back to whatever domain actually serves the current request
 * (e.g. the Cloudflare-assigned workers.dev subdomain) so auth and displayed
 * endpoints keep working out of the box.
 */

const PLACEHOLDER_URLS = new Set(["https://your-domain.com"]);

/** Normalize a configured URL, treating unset/placeholder values as missing. */
export function normalizeConfiguredUrl(
  value: string | undefined,
): string | undefined {
  const raw = value?.trim().replace(/\/+$/, "");
  if (!raw || PLACEHOLDER_URLS.has(raw)) return undefined;
  return raw;
}

/**
 * Effective public base URL for a request: the operator-configured value when
 * set, otherwise the origin that served the request.
 */
export function effectiveBaseUrl(
  configured: string | undefined,
  requestUrl: string,
): string {
  return normalizeConfiguredUrl(configured) ?? new URL(requestUrl).origin;
}
