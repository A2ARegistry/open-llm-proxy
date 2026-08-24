import { describe, it, expect } from "vitest";
import { effectiveBaseUrl, normalizeConfiguredUrl } from "~/src/utils/base-url";

describe("normalizeConfiguredUrl", () => {
  it("returns undefined for unset/blank values", () => {
    expect(normalizeConfiguredUrl(undefined)).toBeUndefined();
    expect(normalizeConfiguredUrl("")).toBeUndefined();
    expect(normalizeConfiguredUrl("   ")).toBeUndefined();
  });

  it("treats public-repo placeholder URLs as unset", () => {
    expect(normalizeConfiguredUrl("https://your-domain.com")).toBeUndefined();
    expect(normalizeConfiguredUrl("https://your-domain.com/")).toBeUndefined();
  });

  it("passes through real URLs, trimming trailing slashes", () => {
    expect(normalizeConfiguredUrl("https://proxy.example.com")).toBe(
      "https://proxy.example.com",
    );
    expect(normalizeConfiguredUrl("https://proxy.example.com/")).toBe(
      "https://proxy.example.com",
    );
    // A different domain that merely contains the placeholder text is valid.
    expect(normalizeConfiguredUrl("https://your-domain.com.evil.io")).toBe(
      "https://your-domain.com.evil.io",
    );
  });
});

describe("effectiveBaseUrl", () => {
  const requestUrl =
    "https://open-llm-proxy.lingering-union-1543.workers.dev/api/keys";

  it("falls back to the serving origin when nothing is configured", () => {
    expect(effectiveBaseUrl("https://your-domain.com", requestUrl)).toBe(
      "https://open-llm-proxy.lingering-union-1543.workers.dev",
    );
    expect(effectiveBaseUrl(undefined, requestUrl)).toBe(
      "https://open-llm-proxy.lingering-union-1543.workers.dev",
    );
  });

  it("prefers the configured URL when present", () => {
    expect(effectiveBaseUrl("https://zervice.me", requestUrl)).toBe(
      "https://zervice.me",
    );
  });
});
