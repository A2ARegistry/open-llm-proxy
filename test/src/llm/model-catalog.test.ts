import { describe, it, expect } from "vitest";
import {
  builtinCatalogId,
  builtinModels,
  defaultModelFor,
  isGeminiFamily,
  mergeModels,
  normalizeProviderModelId,
  registeredProviderId,
  resolveDefaultModel,
  synthesizedMetadata,
} from "~/src/llm/model-catalog";

describe("model-catalog", () => {
  it("resolves baked catalog ids for registry aliases", () => {
    expect(builtinCatalogId("google-ai-studio")).toBe("google");
    expect(builtinCatalogId("google")).toBe("google");
    expect(builtinCatalogId("google-vertex")).toBe("google-vertex");
    expect(builtinCatalogId("openai")).toBe("openai");
    expect(builtinCatalogId("xai")).toBe("xai");
    expect(builtinCatalogId("ollama")).toBeUndefined();
  });

  it("returns baked models for covered providers and none otherwise", () => {
    expect(builtinModels("google-ai-studio").length).toBeGreaterThan(0);
    expect(builtinModels("google-vertex").length).toBe(13);
    expect(builtinModels("ollama")).toEqual([]);
  });

  it("maps registry names to the provider id pi-ai registers", () => {
    expect(registeredProviderId("google-ai-studio")).toBe("google");
    expect(registeredProviderId("google-vertex")).toBe("google-vertex");
    expect(registeredProviderId("ollama")).toBe("ollama");
  });

  it("recognizes Gemini-family ids", () => {
    expect(isGeminiFamily("gemini-2.5-pro")).toBe(true);
    expect(isGeminiFamily("gemma-3")).toBe(true);
    expect(isGeminiFamily("gpt-4o")).toBe(false);
  });

  it("synthesizes metadata for unknown gemini models", () => {
    const meta = synthesizedMetadata("gemini-5.0-pro");
    expect(meta.reasoning).toBe(true);
    expect(meta.contextWindow).toBe(1048576);
    expect(meta.maxTokens).toBe(65536);
    expect(meta.cost).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      cacheWrite: 0,
    });
    expect(synthesizedMetadata("gemini-3.1-flash-lite").cost).toEqual({
      input: 0.1,
      output: 0.4,
      cacheRead: 0.01,
      cacheWrite: 0,
    });
  });

  it("returns empty metadata for non-gemini models", () => {
    expect(synthesizedMetadata("gpt-99")).toEqual({});
  });

  it("merges extra ids into baked with baked winning on duplicates", () => {
    const baked = [{ id: "a" }, { id: "b" }];
    const extra = [{ id: "b" }, { id: "c" }];
    expect(mergeModels(baked, extra)).toEqual([
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ]);
  });

  it("normalizes upstream model id prefixes per provider", () => {
    expect(
      normalizeProviderModelId("models/gemini-2.5-pro", "google-ai-studio"),
    ).toBe("gemini-2.5-pro");
    expect(
      normalizeProviderModelId("google/gemini-2.5-pro", "google-vertex"),
    ).toBe("gemini-2.5-pro");
    expect(normalizeProviderModelId("gemini-2.5-pro", "google-vertex")).toBe(
      "gemini-2.5-pro",
    );
  });

  it("curates a default model id per covered provider", () => {
    expect(defaultModelFor("google-ai-studio")).toBe("gemini-2.5-flash");
    expect(defaultModelFor("google-vertex")).toBe("gemini-2.5-flash");
    expect(defaultModelFor("openai")).toBe("gpt-4o-mini");
    expect(defaultModelFor("anthropic")).toBe("claude-haiku-4-5");
    expect(defaultModelFor("xai")).toBe("grok-4.6");
    expect(defaultModelFor("ollama")).toBe("llama3.1");
  });

  it("falls back to a flash-class model for covered providers without a curated id", () => {
    expect(defaultModelFor("google")).toMatch(/flash/i);
  });

  it("returns undefined when no baked models exist", () => {
    expect(defaultModelFor("custom-openai")).toBeUndefined();
  });

  it("lets settings.defaultModel win over the built-in default", () => {
    expect(
      resolveDefaultModel({ defaultModel: "gemini-5.0" }, "google-vertex"),
    ).toBe("gemini-5.0");
    expect(
      resolveDefaultModel({ defaultModel: "  gemini-5.0  " }, "google-vertex"),
    ).toBe("gemini-5.0");
    expect(resolveDefaultModel({ defaultModel: "" }, "google-vertex")).toBe(
      "gemini-2.5-flash",
    );
    expect(resolveDefaultModel({}, "openai")).toBe("gpt-4o-mini");
    expect(resolveDefaultModel(undefined, "custom-openai")).toBeUndefined();
  });
});
