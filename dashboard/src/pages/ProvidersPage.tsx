import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Modal,
  Select,
  Spinner,
} from "../components/ui";
import {
  apiGet,
  apiSend,
  CatalogProvider,
  ProviderTestResult,
  ProviderTestDetails,
  ProviderView,
} from "../lib/api";
import { fmtDate } from "../lib/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  CheckCircle2,
  Loader2,
  Plus,
  Power,
  Trash2,
  Wifi,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

const KEY_MASK = "••••••••••••";

const PROVIDER_CATALOG: { id: string; name: string; needsKey: boolean }[] = [
  { id: "openai", name: "OpenAI", needsKey: true },
  { id: "anthropic", name: "Anthropic", needsKey: true },
  {
    id: "google-ai-studio",
    name: "Google AI Studio (Gemini API)",
    needsKey: true,
  },
  { id: "google-vertex", name: "Google Vertex AI", needsKey: true },
  { id: "deepseek", name: "DeepSeek", needsKey: true },
  { id: "mistral", name: "Mistral", needsKey: true },
  { id: "groq", name: "Groq", needsKey: true },
  { id: "grok", name: "xAI (Grok)", needsKey: true },
  { id: "cerebras", name: "Cerebras", needsKey: true },
  { id: "openrouter", name: "OpenRouter", needsKey: true },
  { id: "huggingface", name: "HuggingFace", needsKey: true },
  { id: "ollama", name: "Ollama", needsKey: false },
  { id: "cohere", name: "Cohere", needsKey: true },
  { id: "perplexity-ai", name: "Perplexity AI", needsKey: true },
  { id: "custom", name: "Custom OpenAI-compatible", needsKey: true },
];

export function ProvidersPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{
    provider: string;
    name: string;
    settings?: Record<string, unknown>;
    defaultModel?: string | null;
    keyCount?: number;
  } | null>(null);
  const [adding, setAdding] = useState(false);

  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ providers: ProviderView[] }>("/api/providers"),
  });

  const catalog = useQuery({
    queryKey: ["providers-catalog"],
    queryFn: () =>
      apiGet<{ providers: CatalogProvider[] }>("/api/providers/catalog"),
  });

  const catalogById = useMemo(
    () =>
      new Map<string, CatalogProvider>(
        (catalog.data?.providers ?? []).map((p) => [p.provider, p]),
      ),
    [catalog.data],
  );

  const toggle = useMutation({
    mutationFn: (p: ProviderView) =>
      apiSend<ProviderView>("PUT", `/api/providers/${p.provider}`, {
        enabled: !p.enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
  });

  const remove = useMutation({
    mutationFn: (provider: string) =>
      apiSend("DELETE", `/api/providers/${provider}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
  });

  const [testing, setTesting] = useState<{
    provider: string;
    result?: ProviderTestResult;
  } | null>(null);

  const runTest = async (provider: string, keys?: string[]) => {
    setTesting({ provider });
    try {
      const result = await apiSend<ProviderTestResult>(
        "POST",
        `/api/providers/${provider}/test`,
        keys ? { keys } : {},
      );
      setTesting({ provider, result });
    } catch (err) {
      setTesting({
        provider,
        result: { ok: false, error: (err as Error).message },
      });
    }
  };

  if (providers.isLoading) return <Spinner label="Loading providers…" />;
  if (providers.error)
    return (
      <EmptyState
        title="Could not load providers"
        description={providers.error.message}
      />
    );

  const list = providers.data?.providers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Providers</h1>
          <p className="text-sm text-gray-500">
            Upstream LLM backends your API keys are routed to.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus size={15} /> Add provider
        </Button>
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Boxes size={36} />}
            title="No providers configured"
            description="Add your first upstream provider to start routing traffic."
            action={
              <Button onClick={() => setAdding(true)}>Add provider</Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {list.map((p) => (
            <Card
              key={p.provider}
              title={p.name}
              subtitle={p.provider}
              actions={
                <div className="flex items-center gap-2">
                  <Badge tone={p.enabled ? "green" : "gray"}>
                    {p.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={
                      toggle.isPending &&
                      toggle.variables?.provider === p.provider
                    }
                    onClick={() => toggle.mutate(p)}
                  >
                    <Power size={13} /> {p.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => runTest(p.provider)}
                  >
                    <Wifi size={13} /> Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing({
                        provider: p.provider,
                        name: p.name,
                        settings: p.settings,
                        defaultModel: p.defaultModel,
                        keyCount: p.keyCount,
                      })
                    }
                  >
                    Configure
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (
                        confirm(
                          `Remove ${p.name}? Its credentials will be deleted.`,
                        )
                      )
                        remove.mutate(p.provider);
                    }}
                  >
                    <Trash2 size={13} className="text-red-500" />
                  </Button>
                </div>
              }
            >
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs text-gray-400">Mode</p>
                  <p className="font-medium">{p.mode}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Keys</p>
                  <p className="font-medium">{p.keyCount}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400">Updated</p>
                  <p className="font-medium">{fmtDate(p.updatedAt)}</p>
                </div>
              </div>
              {p.provider === "google-vertex" && (
                <p className="mt-3 text-xs text-gray-500">
                  {String(p.settings.authMode ?? "—")}
                  {p.settings.projectId
                    ? ` · ${String(p.settings.projectId)}`
                    : ""}
                  {p.settings.location
                    ? ` · ${String(p.settings.location)}`
                    : ""}
                </p>
              )}
              {testing?.provider === p.provider && (
                <TestResultNote testing={testing} />
              )}
            </Card>
          ))}
        </div>
      )}

      {adding && (
        <ProviderFormModal
          provider={null}
          catalogById={catalogById}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            qc.invalidateQueries({ queryKey: ["providers"] });
          }}
        />
      )}
      {editing && (
        <ProviderFormModal
          provider={editing.provider}
          initialSettings={editing.settings}
          catalogById={catalogById}
          initialDefaultModel={editing.defaultModel}
          initialKeyCount={editing.keyCount}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["providers"] });
          }}
        />
      )}
    </div>
  );
}

function TestResultNote({
  testing,
}: {
  testing: { provider: string; result?: ProviderTestResult };
}) {
  if (!testing.result) {
    return (
      <p className="mt-3 flex items-center gap-1 text-xs text-gray-400">
        <Loader2 size={12} className="animate-spin" /> Testing connection…
      </p>
    );
  }
  const r = testing.result;
  return (
    <div className="mt-3">
      <p
        className={`flex items-start gap-1 text-xs ${r.ok ? "text-green-600" : "text-red-600"}`}
      >
        {r.ok ? (
          <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
        ) : (
          <XCircle size={13} className="mt-0.5 shrink-0" />
        )}
        <span>
          {r.ok
            ? `Connection OK${r.modelCount != null ? ` — ${r.modelCount} models available` : ""}`
            : `Connection failed${r.status ? ` (HTTP ${r.status})` : ""}${r.error ? `: ${r.error}` : ""}`}
        </span>
      </p>
      <TestResultDiagnostics details={r.details} />
    </div>
  );
}

function TestResultDiagnostics({
  details,
}: {
  details?: ProviderTestDetails | null;
}) {
  if (!details) return null;
  const rows: [string, string][] = [
    ["Provider", details.provider],
    ["Method", details.method ?? "-"],
    ["Endpoint", details.endpoint ?? "-"],
    ["Key", details.keyHint ?? "-"],
    ["Auth header", details.authHeader ?? "-"],
    [
      "Status",
      details.responseStatus != null ? String(details.responseStatus) : "-",
    ],
    ["Latency", details.latencyMs != null ? `${details.latencyMs}ms` : "-"],
    ["Models", details.modelCount != null ? String(details.modelCount) : "-"],
  ];
  return (
    <details className="mt-2 text-[11px] text-gray-500">
      <summary className="cursor-pointer select-none">Diagnostics</summary>
      <dl className="mt-1 space-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-24 shrink-0 text-gray-400">{k}</dt>
            <dd className="break-all font-mono">{v}</dd>
          </div>
        ))}
        {details.error && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-gray-400">Error</dt>
            <dd className="break-all font-mono">{details.error}</dd>
          </div>
        )}
        {details.requestSnippet && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-gray-400">Request</dt>
            <dd className="break-all whitespace-pre-wrap font-mono">
              {details.requestSnippet}
            </dd>
          </div>
        )}
        {details.responseSnippet && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-gray-400">Response</dt>
            <dd className="break-all whitespace-pre-wrap font-mono">
              {details.responseSnippet}
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}

function VertexAuthModePicker({
  value,
  onChange,
}: {
  value: "api-key" | "service-account";
  onChange: (v: "api-key" | "service-account") => void;
}) {
  const options: { id: "api-key" | "service-account"; label: string }[] = [
    { id: "service-account", label: "Service Account" },
    { id: "api-key", label: "API Key" },
  ];
  return (
    <div className="flex items-center gap-6">
      {options.map((o) => (
        <label
          key={o.id}
          className="flex cursor-pointer items-center gap-2 text-sm"
        >
          <input
            type="radio"
            name="vertex-auth-mode"
            checked={value === o.id}
            onChange={() => onChange(o.id)}
            className="h-4 w-4 accent-indigo-600"
          />
          <span
            className={`font-medium ${value === o.id ? "text-indigo-700" : "text-gray-700"}`}
          >
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}

function ProviderFormModal({
  provider,
  initialSettings,
  catalogById,
  initialDefaultModel,
  initialKeyCount,
  onClose,
  onSaved,
}: {
  provider: string | null;
  initialSettings?: Record<string, unknown>;
  catalogById: Map<string, CatalogProvider>;
  initialDefaultModel?: string | null;
  initialKeyCount?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isVertex = provider === "google-vertex";
  const isCustom = provider != null && !catalogById.has(provider) && provider !== "google-vertex";
  const [selected, setSelected] = useState(provider ?? PROVIDER_CATALOG[0].id);
  const hasExistingKeys = (initialKeyCount ?? 0) > 0;
  const [customId, setCustomId] = useState(
    provider && isCustom ? provider : "",
  );
  const [customName, setCustomName] = useState(
    isCustom ? String(initialSettings?.name ?? "") : "",
  );
  const [baseUrl, setBaseUrl] = useState(
    isCustom ? String(initialSettings?.baseUrl ?? "") : "",
  );
  const [chatPath, setChatPath] = useState(
    isCustom ? String(initialSettings?.chatCompletionPath ?? "") : "",
  );
  const [modelsPath, setModelsPath] = useState(
    isCustom ? String(initialSettings?.modelsPath ?? "") : "",
  );
  const [keysText, setKeysText] = useState(
    hasExistingKeys ? KEY_MASK : "",
  );
  const [projectId, setProjectId] = useState(
    isVertex ? String(initialSettings?.projectId ?? "") : "",
  );
  const [location, setLocation] = useState(
    isVertex ? String(initialSettings?.location ?? "") : "",
  );
  const [authMode, setAuthMode] = useState<"api-key" | "service-account">(
    initialSettings?.authMode === "api-key" ? "api-key" : "service-account",
  );
  const [customModelsText, setCustomModelsText] = useState(
    (isVertex || isCustom) && Array.isArray(initialSettings?.customModels)
      ? (initialSettings.customModels as string[]).join("\n")
      : "",
  );
  const [defaultModel, setDefaultModel] = useState(
    provider
      ? String(initialSettings?.defaultModel ?? initialDefaultModel ?? "")
      : (catalogById.get(PROVIDER_CATALOG[0].id)?.defaultModel ?? ""),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);

  const catalogEntry = catalogById.get(selected);
  const catalogName =
    catalogEntry?.name ?? (isCustom && customName ? customName : selected);
  const needsKey = catalogEntry?.needsKey ?? true;
  const isCustomSelected = selected === "custom";
  const targetProvider =
    isCustomSelected && provider == null ? customId.trim() : selected;
  const showCustomFields = isCustomSelected || isCustom;

  const isMaskedKey = (v: string) =>
    v.trim() === "" || v.trim() === KEY_MASK;

  const enteredKeys = () =>
    isMaskedKey(keysText)
      ? []
      : keysText
          .split("\n")
          .map((k) => k.trim())
          .filter(Boolean);

  const parseCustomModels = () =>
    customModelsText
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean);

  const canTest = () => {
    if (isCustomSelected) {
      if (provider == null && !customId.trim()) return false;
      if (!baseUrl.trim()) return false;
      return true;
    }
    const hasRealKey = !isMaskedKey(keysText);
    if (selected === "google-vertex") {
      if (authMode === "service-account") {
        return (
          projectId.trim() &&
          location.trim() &&
          (hasRealKey || hasExistingKeys)
        );
      }
      return hasRealKey || hasExistingKeys;
    }
    return !(needsKey && !hasRealKey && !hasExistingKeys);
  };

  const buildBody = (): {
    keys?: string[];
    settings?: Record<string, unknown>;
  } => {
    const defaultModelSetting =
      defaultModel.trim() !== ""
        ? { defaultModel: defaultModel.trim() }
        : {};
    const keys = enteredKeys();
    const keysSetting = keys.length ? { keys } : {};
    if (selected === "google-vertex") {
      if (authMode === "service-account") {
        return {
          ...keysSetting,
          settings: {
            authMode,
            projectId: projectId.trim(),
            location: location.trim(),
            ...defaultModelSetting,
          },
        };
      }
      return {
        ...keysSetting,
        settings: {
          authMode,
          customModels: parseCustomModels(),
          ...defaultModelSetting,
        },
      };
    }
    if (selected === "custom") {
      return {
        ...keysSetting,
        settings: {
          ...(customName.trim() ? { name: customName.trim() } : {}),
          baseUrl: baseUrl.trim(),
          ...(chatPath.trim()
            ? { chatCompletionPath: chatPath.trim() }
            : {}),
          ...(modelsPath.trim() ? { modelsPath: modelsPath.trim() } : {}),
          customModels: parseCustomModels(),
          ...defaultModelSetting,
        },
      };
    }
    return {
      ...keysSetting,
      settings: defaultModelSetting,
    };
  };

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      await apiSend("PUT", `/api/providers/${targetProvider}`, {
        ...buildBody(),
        enabled: true,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  const runTest = async () => {
    setError(null);
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiSend<ProviderTestResult>(
        "POST",
        `/api/providers/${targetProvider}/test`,
        buildBody(),
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const runFetchModels = async () => {
    setError(null);
    setFetchingModels(true);
    setTestResult(null);
    try {
      const result = await apiSend<{
        ok: boolean;
        models?: { id: string; api: string }[];
        error?: string;
      }>("POST", `/api/providers/${targetProvider}/models`, buildBody());
      if (result.ok && result.models?.length) {
        const ids = result.models.map((m) => m.id);
        setCustomModelsText(ids.join("\n"));
        if (!defaultModel.trim()) setDefaultModel(ids[0]);
        setTestResult({
          ok: true,
          modelCount: ids.length,
          details: { provider: targetProvider, modelCount: ids.length },
        });
      } else {
        setTestResult({
          ok: false,
          error: result.error ?? "No models returned",
        });
      }
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={provider ? `Configure ${catalogName}` : "Add provider"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={runTest}
            loading={testing}
            disabled={!canTest()}
          >
            <Wifi size={14} /> Test connection
          </Button>
          <Button onClick={submit} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!provider && (
          <div>
            <Label>Provider</Label>
            <Select
              value={selected}
              onChange={(v) => {
                setSelected(v as string);
                if (!provider)
                  setDefaultModel(catalogById.get(v as string)?.defaultModel ?? "");
              }}
              options={PROVIDER_CATALOG.map((p) => ({
                value: p.id,
                label: p.name,
              }))}
            />
          </div>
        )}
        {provider && (
          <p className="text-xs text-gray-500">
            Update credentials for this provider. Existing keys are preserved
            unless you enter new ones.
          </p>
        )}

        {selected === "google-vertex" ? (
          <>
            <div>
              <Label>Authentication</Label>
              <VertexAuthModePicker value={authMode} onChange={setAuthMode} />
            </div>
            {authMode === "service-account" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Google Cloud project ID</Label>
                  <Input
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    placeholder="my-gcp-project"
                  />
                </div>
                <div>
                  <Label>Location</Label>
                  <Input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="us-central1 or global"
                  />
                </div>
              </div>
            )}
            <div>
              <Label>
                {authMode === "api-key"
                  ? "Google Cloud API key"
                  : "Service account JSON"}
              </Label>
              {authMode === "api-key" ? (
                <Input
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  onFocus={() => isMaskedKey(keysText) && setKeysText("")}
                  placeholder={
                    hasExistingKeys
                      ? "Key already set — type to replace it"
                      : "AIza…"
                  }
                />
              ) : (
                <textarea
                  className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  rows={6}
                  placeholder={
                    hasExistingKeys
                      ? "Service account already set — type to replace it"
                      : '{\n  "type": "service_account",\n  "client_email": "…",\n  "private_key": "-----BEGIN PRIVATE KEY-----…"\n}'
                  }
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  onFocus={() => isMaskedKey(keysText) && setKeysText("")}
                />
              )}
              <p className="mt-1 text-[11px] text-gray-400">
                {authMode === "api-key"
                  ? "Vertex AI Express Mode — just an API key, no project setup. Create a Google Cloud (or Gemini) API key in your project."
                  : "Paste the service-account JSON. We mint a short-lived OAuth2 token server-side; the key is encrypted at rest."}
              </p>
            </div>
            {authMode === "api-key" && (
              <div>
                <Label>Custom model IDs (optional)</Label>
                <textarea
                  className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  rows={2}
                  placeholder={"gemini-2.5-flash-lite\ngemini-3.5-pro-preview"}
                  value={customModelsText}
                  onChange={(e) => setCustomModelsText(e.target.value)}
                />
                <p className="mt-1 text-[11px] text-gray-400">
                  One model id per line, shown in /v1/models. Any model id works
                  at request time even without listing it here.
                </p>
              </div>
            )}
          </>
        ) : showCustomFields ? (
          <>
            {provider == null && (
              <div>
                <Label>Provider id (used in requests as `id/model`)</Label>
                <Input
                  value={customId}
                  onChange={(e) => setCustomId(e.target.value)}
                  placeholder="my-llm"
                />
                <p className="mt-1 text-[11px] text-gray-400">
                  Lowercase letters, digits and dashes. This is the id you will
                  reference as <code>my-llm/model-id</code>.
                </p>
              </div>
            )}
            <div>
              <Label>Display name (optional)</Label>
              <Input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="My internal gateway"
              />
            </div>
            <div>
              <Label>Base URL (required)</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://gateway.example.com/v1 or http://localhost:11434/v1"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Chat and model-list paths are appended to the base URL, e.g.{" "}
                <code>{baseUrl || "https://host/v1"}
                  {chatPath.trim() || "/chat/completions"}</code>.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Chat path (optional)</Label>
                <Input
                  value={chatPath}
                  onChange={(e) => setChatPath(e.target.value)}
                  placeholder="/chat/completions"
                />
              </div>
              <div>
                <Label>Models path (optional)</Label>
                <Input
                  value={modelsPath}
                  onChange={(e) => setModelsPath(e.target.value)}
                  placeholder="/models"
                />
              </div>
            </div>
            <div>
              <Label>API key(s) — optional for local endpoints</Label>
              <textarea
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                rows={2}
                placeholder={
                  hasExistingKeys
                    ? "Key already set — type to replace it"
                    : "sk-… (leave empty for keyless local servers)"
                }
                value={keysText}
                onChange={(e) => setKeysText(e.target.value)}
                onFocus={() => isMaskedKey(keysText) && setKeysText("")}
              />
            </div>
            <div>
              <Label>Custom model IDs (optional)</Label>
              <textarea
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                rows={2}
                placeholder={"my-model-1\nmy-model-2"}
                value={customModelsText}
                onChange={(e) => setCustomModelsText(e.target.value)}
              />
              <div className="mt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runFetchModels}
                  loading={fetchingModels}
                  disabled={!baseUrl.trim() || (provider == null && !customId.trim())}
                >
                  <Wifi size={13} /> Fetch models from endpoint
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-gray-400">
                One model id per line. Use "Fetch models" to pull the live list
                from the endpoint, or enter ids by hand. Any model id works at
                request time even without listing it here.
              </p>
            </div>
          </>
        ) : (
          <div>
            <Label>API key(s)</Label>
            <textarea
              className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              rows={3}
              placeholder={
                hasExistingKeys
                  ? "Key already set — type to replace it"
                  : needsKey === false
                    ? "(optional for local providers)"
                    : "sk-…"
              }
              value={keysText}
              onChange={(e) => setKeysText(e.target.value)}
              onFocus={() => isMaskedKey(keysText) && setKeysText("")}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              {hasExistingKeys
                ? `${initialKeyCount} key${initialKeyCount === 1 ? "" : "s"} already stored (encrypted at rest). Leave as-is to keep them, or type new key(s) to replace them.`
                : "One key per line. Keys are encrypted at rest."}
            </p>
          </div>
        )}

        <div>
          <Label>Default model</Label>
          <Input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="e.g. gemini-2.5-flash"
          />
          <p className="mt-1 text-[11px] text-gray-400">
            {showCustomFields
              ? "Required for the connection test and for requests that omit the model id. Set it to one of the model ids above."
              : "Used when a request omits the model id, and by the connection test. Leave empty to use the built-in default."}
          </p>
        </div>

        {testResult && (
          <div>
            <p
              className={`flex items-start gap-1 text-xs ${testResult.ok ? "text-green-600" : "text-red-600"}`}
            >
              {testResult.ok ? (
                <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
              ) : (
                <XCircle size={13} className="mt-0.5 shrink-0" />
              )}
              <span>
                {testResult.ok
                  ? `Connection OK${testResult.modelCount != null ? ` — ${testResult.modelCount} models available` : ""}. You can save this provider.`
                  : `Connection failed${testResult.status ? ` (HTTP ${testResult.status})` : ""}${testResult.error ? `: ${testResult.error}` : ""}`}
              </span>
            </p>
            <TestResultDiagnostics details={testResult.details} />
          </div>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
