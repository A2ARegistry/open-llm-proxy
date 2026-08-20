import { describe, it, expect } from "vitest";
import { modelFor } from "~/src/llm/models-factory";
import { providerApiId } from "~/src/llm/provider-registry";

describe("modelFor", () => {
  it("uses baked catalog metadata for known models", () => {
    const m = modelFor(
      "google-vertex",
      "gemini-2.5-pro",
      providerApiId("google-vertex"),
    );
    expect(m.id).toBe("gemini-2.5-pro");
    expect(m.provider).toBe("google-vertex");
    expect(m.api).toBe("google-vertex");
    expect(m.reasoning).toBe(true);
    expect(m.cost?.input).toBeGreaterThan(0);
    expect(m.contextWindow).toBeGreaterThan(0);
  });

  it("sets provider to the id pi-ai registers (google-ai-studio → google)", () => {
    const m = modelFor(
      "google-ai-studio",
      "gemini-2.5-pro",
      providerApiId("google-ai-studio"),
    );
    expect(m.provider).toBe("google");
    expect(m.api).toBe("google-generative-ai");
  });

  it("synthesizes metadata for unknown gemini models", () => {
    const m = modelFor(
      "google-vertex",
      "gemini-5.0",
      providerApiId("google-vertex"),
    );
    expect(m.reasoning).toBe(true);
    expect(m.contextWindow).toBe(1048576);
    expect(m.maxTokens).toBe(65536);
    expect(m.cost?.input).toBe(0.3);
    expect(m.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
  });

  it("keeps conservative fallbacks for unknown non-gemini models", () => {
    const m = modelFor("openai", "gpt-99", providerApiId("openai"));
    expect(m.reasoning).toBe(false);
    expect(m.contextWindow).toBe(128000);
    expect(m.maxTokens).toBe(8192);
    expect(m.cost?.input).toBe(0);
  });
});
