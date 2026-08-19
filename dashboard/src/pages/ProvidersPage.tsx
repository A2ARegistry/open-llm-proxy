import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus, Power, Trash2 } from "lucide-react";
import { apiGet, apiSend, ProviderView } from "../lib/api";
import { fmtDate } from "../lib/format";
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

const PROVIDER_CATALOG: { id: string; name: string; needsKey: boolean }[] = [
  { id: "openai", name: "OpenAI", needsKey: true },
  { id: "anthropic", name: "Anthropic", needsKey: true },
  { id: "google-ai-studio", name: "Google AI Studio", needsKey: true },
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
  const [editing, setEditing] = useState<{ provider: string; name: string } | null>(null);
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
    mutationFn: (provider: string) => apiSend("DELETE", `/api/providers/${provider}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["providers"] }),
  });

  if (providers.isLoading) return <Spinner label="Loading providers…" />;
  if (providers.error)
    return <EmptyState title="Could not load providers" description={providers.error.message} />;

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
            action={<Button onClick={() => setAdding(true)}>Add provider</Button>}
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
                    loading={toggle.isPending && toggle.variables?.provider === p.provider}
                    onClick={() => toggle.mutate(p)}
                  >
                    <Power size={13} /> {p.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ provider: p.provider, name: p.name })}>
                    Configure
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Remove ${p.name}? Its credentials will be deleted.`)) remove.mutate(p.provider);
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
              <p className="mt-3 text-xs text-gray-500">
                Default model: {p.defaultModel ?? "auto"}
              </p>
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

function ProviderFormModal({
  provider,
  onClose,
  onSaved,
}: {
  provider: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState(provider ?? PROVIDER_CATALOG[0].id);
  const [keysText, setKeysText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const catalogName = PROVIDER_CATALOG.find((p) => p.id === selected)?.name ?? selected;

  const submit = async () => {
    setError(null);
    const keys = keysText
      .split("\n")
      .map((k) => k.trim())
      .filter(Boolean);
    try {
      await apiSend("PUT", `/api/providers/${selected}`, {
        keys: keys.length ? keys : undefined,
        defaultModel: defaultModel.trim() || undefined,
        enabled: true,
        settings: {},
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
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
            <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {PROVIDER_CATALOG.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {provider && (
          <p className="text-xs text-gray-500">
            Update credentials or default model for this provider.
          </p>
        )}
        <div>
          <Label>API key(s)</Label>
          <textarea
            className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            rows={3}
            placeholder={PROVIDER_CATALOG.find((p) => p.id === selected)?.needsKey === false ? "(optional for local providers)" : "sk-…"}
            value={keysText}
            onChange={(e) => setKeysText(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-gray-400">One key per line. Keys are encrypted at rest.</p>
        </div>
        <div>
          <Label>Default model</Label>
          <Input
            placeholder="e.g. gpt-4o-mini"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
          />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}