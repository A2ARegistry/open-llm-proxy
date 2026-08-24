import type { AppBindings } from "../app";
import { auditLog } from "../audit/audit-logger";
import {
  deleteProviderConfig,
  getProviderConfig,
  listProviderConfigs,
  saveProviderConfig,
  SaveProviderConfigInput,
} from "../llm/credential-store";
import { parseVertexConfig } from "../llm/google-vertex";
import { defaultModelFor, resolveDefaultModel } from "../llm/model-catalog";
import {
  getPiAiProviderSpec,
  getV1ProviderSpec,
  isCustomProviderName,
  listBuiltinProviders,
  PROVIDER_ID_RE,
  resolveProviderMode,
} from "../llm/provider-registry";
import {
  fetchProviderModels,
  testProviderConnection,
} from "../llm/provider-test";
import { Hono } from "hono";

const MAX_KEYS_PER_PROVIDER = 20;

const BASE_URL_RE = /^https?:\/\/.+/;

/**
 * Generate a default display name for a provider based on its catalog name
 * and the existing providers of the same type.
 * Example: "Google Vertex AI Provider", "Google Vertex AI Provider 2"
 */
function generateDefaultProviderName(
  provider: string,
  existingProviders: Array<{ provider: string; name: string }>,
): string {
  const spec = getPiAiProviderSpec(provider);
  const v1Spec = getV1ProviderSpec(provider);
  const baseName = spec?.name ?? v1Spec?.name ?? provider;

  // Count how many providers of the same base name already exist
  const sameTypeCount = existingProviders.filter((p) => {
    const pSpec = getPiAiProviderSpec(p.provider);
    const pV1Spec = getV1ProviderSpec(p.provider);
    const pBaseName = pSpec?.name ?? pV1Spec?.name ?? p.provider;
    return pBaseName === baseName;
  }).length;

  if (sameTypeCount === 0) {
    return `${baseName} Provider`;
  } else {
    return `${baseName} Provider ${sameTypeCount + 1}`;
  }
}

function publicProviderView(input: {
  provider: string;
  name?: string;
  configured: boolean;
  enabled: boolean;
  settings: Record<string, unknown>;
  keyCount: number;
  updatedAt?: number;
}) {
  const spec = getPiAiProviderSpec(input.provider);
  const v1Spec = getV1ProviderSpec(input.provider);

  // Resolution priority: DB name column > settings.name > registry name > provider slug
  let displayName: string;
  if (input.name && input.name.trim()) {
    displayName = input.name.trim();
  } else if (
    typeof input.settings?.name === "string" &&
    input.settings.name.trim()
  ) {
    displayName = input.settings.name.trim();
  } else {
    displayName = spec?.name ?? v1Spec?.name ?? input.provider;
  }

  return {
    provider: input.provider,
    name: displayName,
    mode: resolveProviderMode(input.provider),
    configured: input.configured,
    enabled: input.enabled,
    settings: input.settings,
    keyCount: input.keyCount,
    defaultModel: resolveDefaultModel(input.settings, input.provider) ?? null,
    updatedAt: input.updatedAt ?? null,
  };
}

function validateSettings(settings: unknown): Record<string, unknown> {
  if (settings === undefined) return {};
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  ) {
    throw new Error("settings must be an object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key === "chatCompletionPath" || key === "modelsPath") {
      if (typeof value !== "string" || !value.startsWith("/")) {
        throw new Error(`settings.${key} must be an absolute path`);
      }
    } else if (key === "baseUrl") {
      if (typeof value !== "string" || !BASE_URL_RE.test(value.trim())) {
        throw new Error("settings.baseUrl must be an http(s) URL");
      }
      out[key] = value.trim();
      continue;
    } else if (key === "name") {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("settings.name must be a non-empty string");
      }
      out[key] = value.trim();
      continue;
    } else if (key === "customModels") {
      if (
        !Array.isArray(value) ||
        value.some((m) => typeof m !== "string" || m.trim().length === 0)
      ) {
        throw new Error("settings.customModels must be an array of strings");
      }
      out[key] = (value as string[]).map((m) => m.trim());
      continue;
    }
    out[key] = value;
  }
  return out;
}

export const providerConfigRouter = new Hono<AppBindings>();

// GET /api/providers/catalog — built-in providers with their default models,
// so the dashboard can prefill config forms, plus the generic custom
// OpenAI-compatible option (no curated default model).
providerConfigRouter.get("/catalog", async (c) => {
  const rows = listBuiltinProviders().map((entry) => ({
    ...entry,
    defaultModel: defaultModelFor(entry.provider) ?? null,
  }));
  rows.push({
    provider: "custom",
    name: "Custom OpenAI-compatible",
    mode: "v1",
    needsKey: true,
    defaultModel: null,
  });
  return c.json({ providers: rows });
});

// GET /api/providers — list configured providers for the tenant.
providerConfigRouter.get("/", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const configs = await listProviderConfigs(c.env, orgId);
  const rows = configs.map((cfg) =>
    publicProviderView({
      provider: cfg.provider,
      name: cfg.name,
      configured: true,
      enabled: cfg.enabled,
      settings: cfg.settings,
      keyCount: cfg.keys.length,
      updatedAt: cfg.updatedAt,
    }),
  );
  return c.json({ providers: rows });
});

// GET /api/providers/:provider — detail for one provider.
providerConfigRouter.get("/:provider", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const provider = c.req.param("provider");
  const cfg = await getProviderConfig(c.env, orgId, provider);
  if (!cfg) {
    return c.json(
      {
        error: "not_configured",
        provider: publicProviderView({
          provider,
          configured: false,
          enabled: false,
          settings: {},
          keyCount: 0,
        }),
      },
      404,
    );
  }
  return c.json(
    publicProviderView({
      provider: cfg.provider,
      name: cfg.name,
      configured: true,
      enabled: cfg.enabled,
      settings: cfg.settings,
      keyCount: cfg.keys.length,
      updatedAt: cfg.updatedAt,
    }),
  );
});

// PUT /api/providers/:provider — create or update provider credentials/settings.
providerConfigRouter.put("/:provider", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const provider = c.req.param("provider");

  if (!PROVIDER_ID_RE.test(provider)) {
    return c.json({ error: "Invalid provider id" }, 400);
  }

  const body = (await c.req
    .json()
    .catch(() => null)) as Partial<SaveProviderConfigInput> | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const keys = body.keys;
  if (keys !== undefined) {
    if (
      !Array.isArray(keys) ||
      keys.some((k) => typeof k !== "string" || k.trim().length === 0) ||
      keys.length > MAX_KEYS_PER_PROVIDER
    ) {
      return c.json(
        {
          error: `keys must be a non-empty array of strings (max ${MAX_KEYS_PER_PROVIDER})`,
        },
        400,
      );
    }
  }

  let settings: Record<string, unknown>;
  try {
    settings = validateSettings(body.settings);
    if (provider === "google-vertex") {
      // Vertex settings carry the auth mode + GCP project/location; validate
      // them together with the credential before persisting anything. When no
      // new key is supplied (dashboard mask), the stored key validates.
      const existing = await getProviderConfig(c.env, orgId, provider);
      const effectiveKeys = keys ?? existing?.keys ?? [];
      parseVertexConfig({ settings, keys: effectiveKeys });
    }
    if (isCustomProviderName(provider)) {
      // A custom OpenAI-compatible endpoint is only meaningful with a base URL.
      if (typeof settings.baseUrl !== "string" || !settings.baseUrl) {
        throw new Error("settings.baseUrl is required for custom providers");
      }
    }
    if ("trace" in settings && typeof settings.trace !== "boolean") {
      throw new Error("settings.trace must be a boolean");
    }
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // Validate the name field (top-level, not in settings)
  let name: string | undefined;
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return c.json({ error: "name must be a non-empty string" }, 400);
    }
    name = body.name.trim();
  }

  // Auto-generate name for new providers if not provided
  if (!name) {
    const existing = await getProviderConfig(c.env, orgId, provider);
    if (!existing) {
      // This is a new provider, generate a default name
      const allProviders = await listProviderConfigs(c.env, orgId);
      name = generateDefaultProviderName(
        provider,
        allProviders.map((p) => ({ provider: p.provider, name: p.name })),
      );
    }
  }

  const input: SaveProviderConfigInput = {
    keys: keys?.map((k) => k.trim()),
    enabled: body.enabled,
    name,
    settings,
  };

  // Capture prior trace state so we can warn on the enabling transition.
  const wasTraceEnabled =
    settings.trace === true
      ? (await getProviderConfig(c.env, orgId, provider))?.settings?.trace ===
        true
      : false;

  try {
    const saved = await saveProviderConfig(c.env, orgId, provider, input);
    const traceEnabled = saved.settings?.trace === true;
    await auditLog(c.env, {
      organizationId: orgId,
      userId: session.userId,
      action: "update",
      resourceType: "provider",
      resourceId: saved.id,
      details: {
        provider,
        name: saved.name,
        enabled: saved.enabled,
        keysChanged: keys !== undefined,
        keyCount: saved.keys.length,
        trace: traceEnabled,
      },
    });
    // Warn loudly when diagnostic tracing was just turned on (testing only).
    const warnings: string[] = [];
    if (traceEnabled && !wasTraceEnabled) {
      warnings.push(
        "Diagnostic tracing is ENABLED for this provider. Full request and response payloads — including user message content — will be written to worker logs. Use only while testing and disable it afterwards.",
      );
    }
    return c.json(
      {
        ...publicProviderView({
          provider: saved.provider,
          name: saved.name,
          configured: true,
          enabled: saved.enabled,
          settings: saved.settings,
          keyCount: saved.keys.length,
          updatedAt: saved.updatedAt,
        }),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      200,
    );
  } catch (err) {
    if (err instanceof Error && /ENCRYPTION_KEY/.test(err.message)) {
      return c.json(
        { error: "Encryption is not configured on the server" },
        500,
      );
    }
    throw err;
  }
});

// POST /api/providers/:provider/test — probe connectivity with candidate keys.
// If `keys` are supplied they are tested as-is (nothing is persisted); otherwise
// the stored config's keys are used.
providerConfigRouter.post("/:provider/test", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const provider = c.req.param("provider");

  if (!PROVIDER_ID_RE.test(provider)) {
    return c.json({ error: "Invalid provider id" }, 400);
  }

  const body = (await c.req.json().catch(() => null)) as {
    keys?: unknown;
    settings?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  let keys: string[] | undefined;
  if (body.keys !== undefined) {
    if (
      !Array.isArray(body.keys) ||
      body.keys.some((k) => typeof k !== "string" || k.trim().length === 0) ||
      body.keys.length > MAX_KEYS_PER_PROVIDER
    ) {
      return c.json(
        {
          error: `keys must be a non-empty array of strings (max ${MAX_KEYS_PER_PROVIDER})`,
        },
        400,
      );
    }
    keys = (body.keys as string[]).map((k) => k.trim());
  }

  let settings: Record<string, unknown>;
  try {
    settings = validateSettings(body.settings);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  let testKeys = keys;
  let testSettings = settings;
  if (testKeys === undefined) {
    const cfg = await getProviderConfig(c.env, orgId, provider);
    if (!cfg) {
      return c.json(
        {
          error:
            "Provider is not configured. Save it first or provide keys to test.",
        },
        404,
      );
    }
    testKeys = cfg.keys;
    testSettings = { ...cfg.settings, ...settings };
  }

  const result = await testProviderConnection({
    provider,
    keys: testKeys,
    settings: testSettings,
  });
  return c.json(result);
});

// POST /api/providers/:provider/models — fetch the live model list for a
// provider with candidate keys/settings (unsaved or stored), so custom
// endpoints can be configured from their real model ids.
providerConfigRouter.post("/:provider/models", async (c) => {
  const orgId = c.get("session")!.organizationId!;
  const provider = c.req.param("provider");

  if (!PROVIDER_ID_RE.test(provider)) {
    return c.json({ error: "Invalid provider id" }, 400);
  }

  const body = (await c.req.json().catch(() => null)) as {
    keys?: unknown;
    settings?: unknown;
  } | null;
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  let keys: string[] | undefined;
  if (body.keys !== undefined) {
    if (
      !Array.isArray(body.keys) ||
      body.keys.some((k) => typeof k !== "string" || k.trim().length === 0) ||
      body.keys.length > MAX_KEYS_PER_PROVIDER
    ) {
      return c.json(
        {
          error: `keys must be a non-empty array of strings (max ${MAX_KEYS_PER_PROVIDER})`,
        },
        400,
      );
    }
    keys = (body.keys as string[]).map((k) => k.trim());
  }

  let settings: Record<string, unknown>;
  try {
    settings = validateSettings(body.settings);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  let testKeys = keys;
  let testSettings = settings;
  if (testKeys === undefined) {
    const cfg = await getProviderConfig(c.env, orgId, provider);
    if (!cfg) {
      return c.json(
        { error: "Provider is not configured. Save it first or provide keys." },
        404,
      );
    }
    testKeys = cfg.keys;
    testSettings = { ...cfg.settings, ...settings };
  }

  const result = await fetchProviderModels({
    provider,
    keys: testKeys,
    settings: testSettings,
  });
  return c.json(result);
});

// DELETE /api/providers/:provider — remove the provider config entirely.
providerConfigRouter.delete("/:provider", async (c) => {
  const session = c.get("session")!;
  const orgId = session.organizationId!;
  const provider = c.req.param("provider");

  if (!PROVIDER_ID_RE.test(provider)) {
    return c.json({ error: "Invalid provider id" }, 400);
  }

  const deleted = await deleteProviderConfig(c.env, orgId, provider);
  if (!deleted) {
    return c.json({ error: "Provider config not found" }, 404);
  }
  await auditLog(c.env, {
    organizationId: orgId,
    userId: session.userId,
    action: "delete",
    resourceType: "provider",
    details: { provider },
  });
  return c.json({ ok: true });
});
