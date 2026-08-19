import { describe, it, expect } from "vitest";
import {
  VERTEX_PROVIDER_ID,
  isVertexProvider,
  parseVertexConfig,
  vertexBaseUrl,
  vertexChatCompletionsPath,
  vertexModelsPath,
  resolveVertexHeaders,
  vertexModelId,
} from "~/src/llm/google-vertex";

describe("google-vertex helpers", () => {
  it("recognizes google-vertex (and aliases) as the Vertex provider", () => {
    expect(isVertexProvider("google-vertex")).toBe(true);
    expect(isVertexProvider("vertex")).toBe(true);
    expect(isVertexProvider("google-ai-studio")).toBe(false);
  });

  it("parses a valid api-key config", () => {
    const out = parseVertexConfig({
      settings: {
        authMode: "api-key",
        projectId: " my-project ",
        location: " us-central1 ",
      },
      keys: ["AIza-key"],
    });
    expect(out).toEqual({
      settings: {
        authMode: "api-key",
        projectId: "my-project",
        location: "us-central1",
      },
      credential: "AIza-key",
    });
  });

  it("rejects an invalid authMode", () => {
    expect(() =>
      parseVertexConfig({
        settings: { authMode: "bogus", projectId: "p", location: "l" },
        keys: ["k"],
      }),
    ).toThrow(/authMode/);
  });

  it("requires a project ID and location", () => {
    expect(() =>
      parseVertexConfig({
        settings: { authMode: "api-key", projectId: "", location: "us" },
        keys: ["k"],
      }),
    ).toThrow(/project ID/);
    expect(() =>
      parseVertexConfig({
        settings: { authMode: "api-key", projectId: "p", location: " " },
        keys: ["k"],
      }),
    ).toThrow(/location/);
  });

  it("requires a credential in both modes", () => {
    expect(() =>
      parseVertexConfig({
        settings: { authMode: "api-key", projectId: "p", location: "us" },
        keys: [],
      }),
    ).toThrow(/API key/);
    expect(() =>
      parseVertexConfig({
        settings: {
          authMode: "service-account",
          projectId: "p",
          location: "us",
        },
        keys: [],
      }),
    ).toThrow(/service account/);
  });

  it("builds the correct regional/global base URLs", () => {
    expect(vertexBaseUrl("us-central1")).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1",
    );
    expect(vertexBaseUrl("global")).toBe(
      "https://aiplatform.googleapis.com/v1",
    );
  });

  it("builds OpenAI-compatible chat/models paths", () => {
    expect(vertexChatCompletionsPath("p", "us-central1")).toBe(
      "/projects/p/locations/us-central1/endpoints/openapi/chat/completions",
    );
    expect(vertexModelsPath("p", "global")).toBe(
      "/projects/p/locations/global/endpoints/openapi/models",
    );
  });

  it("resolves api-key auth to x-goog-api-key", async () => {
    const headers = await resolveVertexHeaders({
      settings: { authMode: "api-key", projectId: "p", location: "us" },
      credential: "AIza-xyz",
    });
    expect(headers).toEqual({ "x-goog-api-key": "AIza-xyz" });
  });

  it("prefixes bare Gemini model ids with google/", () => {
    expect(vertexModelId("gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    expect(vertexModelId("google/gemini-2.5-flash")).toBe(
      "google/gemini-2.5-flash",
    );
  });
});
