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
import { apiGet, apiSend, ApiKeyView, ProviderView } from "../lib/api";
import { fmtDate } from "../lib/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

export function ApiKeysPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{
    id: string;
    key: string;
    name: string;
    endpoint?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () => apiGet<{ keys: ApiKeyView[] }>("/api/keys"),
  });

  // Fetch configured providers instead of the full catalog
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiGet<{ providers: ProviderView[] }>("/api/providers"),
  });

  const providerOptions =
    providers.data?.providers.map((p) => ({
      value: p.provider,
      label: p.name,
    })) ?? [];
  const providerName = (id: string | undefined) =>
    id ? (providerOptions.find((o) => o.value === id)?.label ?? id) : undefined;

  const revoke = useMutation({
    mutationFn: (id: string) => apiSend("DELETE", `/api/keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys"] }),
  });

  const rotate = useMutation({
    mutationFn: (id: string) =>
      apiSend<{ id: string; key: string; endpoint: string }>(
        "POST",
        `/api/keys/${id}/rotate`,
      ),
    onSuccess: (data) =>
      setCreated({
        id: data.id,
        key: data.key,
        name: "rotated key",
        endpoint: data.endpoint,
      }),
  });

  if (keys.isLoading) return <Spinner label="Loading keys…" />;
  if (keys.error)
    return (
      <EmptyState
        title="Could not load keys"
        description={keys.error.message}
      />
    );

  const list = keys.data?.keys ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">API Keys</h1>
          <p className="text-sm text-gray-500">
            Programmatic keys for the OpenAI-compatible proxy endpoints.
          </p>
        </div>
        <Button
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
        >
          <Plus size={15} /> Create key
        </Button>
      </div>

      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KeyRound size={36} />}
            title="No API keys yet"
            description="Create a key and use it as the bearer token when calling /v1/chat/completions."
          />
        </Card>
      ) : (
        <Card>
          <div className="-m-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase tracking-wide text-gray-400">
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Prefix</th>
                  <th className="px-5 py-3 font-medium">Endpoint</th>
                  <th className="px-5 py-3 font-medium">Provider</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Spend cap</th>
                  <th className="px-5 py-3 font-medium">Last used</th>
                  <th className="px-5 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((k) => (
                  <tr
                    key={k.id}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="px-5 py-3 font-medium text-gray-800">
                      {k.name}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-gray-500">
                      {k.keyPrefix}…
                    </td>
                    <td className="px-5 py-3">
                      {k.endpoint ? (
                        <code className="text-xs text-gray-600">
                          {k.endpoint}
                        </code>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {k.scopes.defaultProvider ? (
                        <Badge tone="indigo">
                          {providerName(k.scopes.defaultProvider)}
                        </Badge>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={k.status === "active" ? "green" : "red"}>
                        {k.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-gray-600">
                      {k.scopes.spendCapUsd ? `$${k.scopes.spendCapUsd}` : "—"}
                    </td>
                    <td className="px-5 py-3 text-gray-500">
                      {fmtDate(k.lastUsedAt)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => rotate.mutate(k.id)}
                          title="Rotate"
                        >
                          <RotateCcw size={13} />
                        </Button>
                        {k.status === "active" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (confirm(`Revoke key "${k.name}"?`))
                                revoke.mutate(k.id);
                            }}
                            title="Revoke"
                          >
                            <Trash2 size={13} className="text-red-500" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating && (
        <CreateKeyModal
          providerOptions={providerOptions}
          onClose={() => setCreating(false)}
          onCreated={(data) => {
            setCreating(false);
            setCreated(data);
            qc.invalidateQueries({ queryKey: ["keys"] });
          }}
          onError={setError}
        />
      )}

      {created && (
        <KeyRevealModal
          key={created.id}
          data={created}
          onClose={() => setCreated(null)}
        />
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}

function CreateKeyModal({
  providerOptions,
  onClose,
  onCreated,
  onError,
}: {
  providerOptions: { value: string; label: string }[];
  onClose: () => void;
  onCreated: (d: {
    id: string;
    key: string;
    name: string;
    endpoint?: string;
  }) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [spendCapUsd, setSpendCapUsd] = useState("");
  const [defaultProvider, setDefaultProvider] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const scopes: Record<string, unknown> = {};
      const cap = parseFloat(spendCapUsd);
      if (spendCapUsd.trim() !== "" && Number.isFinite(cap) && cap > 0)
        scopes.spendCapUsd = cap;
      if (defaultProvider) scopes.defaultProvider = defaultProvider;
      const res = await apiSend<{
        id: string;
        key: string;
        name: string;
        endpoint: string;
      }>("POST", "/api/keys", {
        name: name.trim() || "default",
        scopes,
      });
      onCreated(res);
    } catch (err) {
      onError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Create API key"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            placeholder="e.g. production"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label>Provider (optional, binds the key)</Label>
          <Select
            className="w-full"
            value={defaultProvider}
            onChange={(v) => setDefaultProvider(v as string)}
            options={providerOptions}
            placeholder="Any provider — requires provider/model"
          />
          <p className="mt-1 text-[11px] text-gray-400">
            Bound keys only route to this provider and accept bare model ids.
          </p>
        </div>
        <div>
          <Label>Spend cap (USD, optional)</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="e.g. 50"
            value={spendCapUsd}
            onChange={(e) => setSpendCapUsd(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

function KeyRevealModal({
  data,
  onClose,
}: {
  data: { id: string; key: string; name: string; endpoint?: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Key created — ${data.name}`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs text-amber-700">
            Copy this key now. It will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-md bg-gray-100 px-3 py-2 font-mono text-xs">
              {data.key}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(data.key);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy size={13} /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>

        {data.endpoint && (
          <div>
            <p className="mb-2 text-xs text-gray-600">
              Base URL for OpenAI-compatible clients:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md bg-gray-100 px-3 py-2 font-mono text-xs">
                {data.endpoint}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(data.endpoint!);
                  setCopiedEndpoint(true);
                  setTimeout(() => setCopiedEndpoint(false), 1500);
                }}
              >
                <Copy size={13} /> {copiedEndpoint ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Use this as the base_url in OpenAI SDK or compatible clients.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
