import { getGoogleAccessToken } from "./google-oauth";
import { canonicalProviderName } from "./provider-registry";

export const VERTEX_PROVIDER_ID = "google-vertex";

export interface VertexSettings {
  authMode: "api-key" | "service-account";
  projectId: string;
  location: string;
}

/** Whether a provider id refers to the Google Vertex AI provider. */
export function isVertexProvider(name: string): boolean {
  return canonicalProviderName(name) === VERTEX_PROVIDER_ID;
}

/**
 * Validate + normalize the per-tenant Vertex settings and the stored
 * credential(s). Throws a descriptive Error on invalid input.
 */
export function parseVertexConfig(input: {
  settings?: Record<string, unknown>;
  keys?: string[];
}): { settings: VertexSettings; credential: string } {
  const raw = input.settings ?? {};
  const authMode = raw.authMode;
  if (authMode !== "api-key" && authMode !== "service-account") {
    throw new Error(
      "Vertex AI requires authMode: 'api-key' or 'service-account'",
    );
  }
  const projectId =
    typeof raw.projectId === "string" ? raw.projectId.trim() : "";
  const location = typeof raw.location === "string" ? raw.location.trim() : "";
  if (!projectId)
    throw new Error("Vertex AI requires a Google Cloud project ID");
  if (!location)
    throw new Error(
      "Vertex AI requires a location (e.g. us-central1 or global)",
    );

  const credential =
    (input.keys ?? []).find(
      (k) => typeof k === "string" && k.trim().length > 0,
    ) ?? "";
  if (!credential) {
    throw new Error(
      authMode === "api-key"
        ? "Vertex AI requires a Google Cloud API key"
        : "Vertex AI requires a service account JSON credential",
    );
  }

  return {
    settings: { authMode, projectId, location },
    credential,
  };
}

/** Regional host per the location; the `global` location has no prefix. */
export function vertexBaseUrl(location: string): string {
  const host =
    location === "global"
      ? "aiplatform.googleapis.com"
      : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1`;
}

export function vertexChatCompletionsPath(
  projectId: string,
  location: string,
): string {
  return `/projects/${projectId}/locations/${location}/endpoints/openapi/chat/completions`;
}

export function vertexModelsPath(projectId: string, location: string): string {
  return `/projects/${projectId}/locations/${location}/endpoints/openapi/models`;
}

/**
 * Resolve the upstream auth headers for a Vertex request. API-key mode sends
 * `x-goog-api-key`; service-account mode mints an OAuth2 token and sends it as
 * a Bearer credential, attributing quota to the project via x-goog-user-project.
 */
export async function resolveVertexHeaders(input: {
  settings: VertexSettings;
  credential: string;
}): Promise<Record<string, string>> {
  const { settings, credential } = input;
  if (settings.authMode === "api-key") {
    return { "x-goog-api-key": credential };
  }
  const token = await getGoogleAccessToken(credential);
  return {
    authorization: `Bearer ${token}`,
    "x-goog-user-project": settings.projectId,
  };
}

/** Prefix a bare Gemini model id with the Vertex `google/` publisher scope. */
export function vertexModelId(modelId: string): string {
  return modelId.includes("/") ? modelId : `google/${modelId}`;
}
