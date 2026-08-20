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
import { apiGet, apiSend, ProviderTestResult, ProviderView } from "../lib/api";
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
import { useState } from "react";

const PROVIDER_CATALOG: { id: string; name: string; needsKey: boolean }[] = [
  { id: "openai", name: "OpenAI", needsKey: true },
  { id: "anthropic", name: "Anthropic", needsKey: true },
  { id: "google-ai-studio", name: "Google AI Studio (Gemini API)", needsKey: true },
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
];

export function ProvidersPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{
    provider: string;
    name: string;
    settings?: Record<string, unknown>;
  } | null>(null);
  const [adding, setAdding] = useState(false);

  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ providers: ProviderView[] }>("/api/providers"),
  });

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
                  {String(p.settings.projectId ?? "—")} ·{" "}
                  {String(p.settings.location ?? "—")} ·{" "}
                  {String(p.settings.authMode ?? "—")}
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
    <p
      className={`mt-3 flex items-start gap-1 text-xs ${r.ok ? "text-green-600" : "text-red-600"}`}
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
  onClose,
  onSaved,
}: {
  provider: string | null;
  initialSettings?: Record<string, unknown>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isVertex = provider === "google-vertex";
  const [selected, setSelected] = useState(
    provider ?? PROVIDER_CATALOG[0].id,
  );
  const [keysText, setKeysText] = useState("");
  const [projectId, setProjectId] = useState(
    isVertex ? String(initialSettings?.projectId ?? "") : "",
  );
  const [location, setLocation] = useState(
    isVertex ? String(initialSettings?.location ?? "") : "",
  );
  const [authMode, setAuthMode] = useState<"api-key" | "service-account">(
    initialSettings?.authMode === "api-key" ? "api-key" : "service-account",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const catalogName =
    PROVIDER_CATALOG.find((p) => p.id === selected)?.name ?? selected;
  const needsKey =
    PROVIDER_CATALOG.find((p) => p.id === selected)?.needsKey ?? true;

  const enteredKeys = () =>
    keysText
      .split("\n")
      .map((k) => k.trim())
      .filter(Boolean);

  const canTest = () => {
    if (selected === "google-vertex") {
      return projectId.trim() && location.trim() && keysText.trim();
    }
    return !(needsKey && !keysText.trim());
  };

  const buildBody = (): { keys?: string[]; settings?: Record<string, unknown> } => {
    if (selected === "google-vertex") {
      return {
        keys: [keysText.trim()],
        settings: {
          authMode,
          projectId: projectId.trim(),
          location: location.trim(),
        },
      };
    }
    const keys = enteredKeys();
    return {
      keys: keys.length ? keys : undefined,
      settings: {},
    };
  };

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      await apiSend("PUT", `/api/providers/${selected}`, {
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
        `/api/providers/${selected}/test`,
        buildBody(),
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
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
              onChange={(v) => setSelected(v as string)}
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
            <div>
              <Label>Authentication</Label>
              <VertexAuthModePicker value={authMode} onChange={setAuthMode} />
            </div>
            <div>
              <Label>
                {authMode === "api-key" ? "Google Cloud API key" : "Service account JSON"}
              </Label>
              {authMode === "api-key" ? (
                <Input
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                  placeholder="AIza…"
                />
              ) : (
                <textarea
                  className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  rows={6}
                  placeholder={"{\n  \"type\": \"service_account\",\n  \"client_email\": \"…\",\n  \"private_key\": \"-----BEGIN PRIVATE KEY-----…\"\n}"}
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                />
              )}
              <p className="mt-1 text-[11px] text-gray-400">
                {authMode === "api-key"
                  ? "Create a Google Cloud API key in your project. Requires the Vertex AI API to be enabled."
                  : "Paste the service-account JSON. We mint a short-lived OAuth2 token server-side; the key is encrypted at rest."}
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
                needsKey === false ? "(optional for local providers)" : "sk-…"
              }
              value={keysText}
              onChange={(e) => setKeysText(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-gray-400">
              One key per line. Keys are encrypted at rest.
            </p>
          </div>
        )}

        {testResult && (
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
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}