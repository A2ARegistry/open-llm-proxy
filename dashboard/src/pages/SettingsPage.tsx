import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Select,
  Spinner,
} from "../components/ui";
import { apiGet, apiSend, TenantInfo } from "../lib/api";
import { fmtUsd } from "../lib/format";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BellRing, Globe, ShieldAlert, Zap } from "lucide-react";
import { useEffect, useState } from "react";

interface AlertSettings {
  enabled: boolean;
  emailEnabled: boolean;
  errorThresholdPct: number;
  errorMinRequests: number;
  errorWindowMinutes: number;
  cooldownMinutes: number;
}

interface WebhookView {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: number;
}

interface AlertEventView {
  id: string;
  eventType: string;
  provider: string | null;
  level: number;
  channel: string;
  status: string;
  createdAt: number;
}

const EMPTY_ALERTS: AlertSettings = {
  enabled: true,
  emailEnabled: true,
  errorThresholdPct: 5,
  errorMinRequests: 20,
  errorWindowMinutes: 30,
  cooldownMinutes: 60,
};

export function SettingsPage() {
  const status = useQuery({
    queryKey: ["spend-status"],
    queryFn: () =>
      apiGet<{
        daily: {
          usageUsd: number;
          limitUsd: number | null;
          percent: number;
          breached: boolean;
          warning: boolean;
        } | null;
        monthly: {
          usageUsd: number;
          limitUsd: number | null;
          percent: number;
          breached: boolean;
          warning: boolean;
        } | null;
      }>("/api/usage/alerts"),
  });
  const alerts = useQuery({
    queryKey: ["alert-config"],
    queryFn: () => apiGet<{ alerts: AlertSettings }>("/api/alerts/config"),
  });
  const webhooks = useQuery({
    queryKey: ["alert-webhooks"],
    queryFn: () =>
      apiGet<{ webhooks: WebhookView[] }>("/api/alerts/webhooks").then(
        (r) => r.webhooks,
      ),
  });
  const events = useQuery({
    queryKey: ["alert-events"],
    queryFn: () =>
      apiGet<{ events: AlertEventView[] }>("/api/alerts/events").then(
        (r) => r.events,
      ),
  });

  const [daily, setDaily] = useState("");
  const [monthly, setMonthly] = useState("");

  const tenant = useQuery({
    queryKey: ["tenant"],
    queryFn: () => apiGet<TenantInfo>("/api/tenant"),
  });
  const [customPrefix, setCustomPrefix] = useState("");
  const [prefixMsg, setPrefixMsg] = useState<string | null>(null);
  const [prefixErr, setPrefixErr] = useState<string | null>(null);

  useEffect(() => {
    if (tenant.data) setCustomPrefix(tenant.data.customPrefix ?? "");
  }, [tenant.data]);

  const savePrefix = useMutation({
    mutationFn: () =>
      apiSend<{ ok: boolean; customPrefix: string | null }>(
        "PUT",
        "/api/tenant/prefix",
        {
          customPrefix: customPrefix.trim() === "" ? null : customPrefix.trim(),
        },
      ),
    onSuccess: (data) => {
      setCustomPrefix(data.customPrefix ?? "");
      setPrefixMsg("Base URL prefix saved.");
      setPrefixErr(null);
      tenant.refetch();
    },
    onError: (err: Error) => {
      setPrefixErr(err.message);
      setPrefixMsg(null);
    },
  });

  const [alertsForm, setAlertsForm] = useState<AlertSettings>(EMPTY_ALERTS);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const [whEvents, setWhEvents] = useState<string[]>(["quota_exceeded"]);
  const [whError, setWhError] = useState<string | null>(null);

  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);

  useEffect(() => {
    if (status.data) {
      setDaily(
        status.data.daily?.limitUsd != null
          ? String(status.data.daily.limitUsd)
          : "",
      );
      setMonthly(
        status.data.monthly?.limitUsd != null
          ? String(status.data.monthly.limitUsd)
          : "",
      );
    }
    if (alerts.data) setAlertsForm(alerts.data.alerts);
  }, [status.data, alerts.data]);

  const saveLimits = useMutation({
    mutationFn: () =>
      apiSend<{ spendLimits: { dailyUsd?: number; monthlyUsd?: number } }>(
        "PUT",
        "/api/usage/limits",
        {
          dailyUsd: daily.trim() === "" ? null : Number(daily),
          monthlyUsd: monthly.trim() === "" ? null : Number(monthly),
        },
      ),
    onSuccess: () => {
      setMessage("Spend limits saved.");
      setError(null);
      status.refetch();
    },
    onError: (err: Error) => setError(err.message),
  });

  const saveAlerts = useMutation({
    mutationFn: () =>
      apiSend<{ alerts: AlertSettings }>(
        "PUT",
        "/api/alerts/config",
        alertsForm,
      ),
    onSuccess: (data) => {
      setAlertsForm(data.alerts);
      setMessage("Alert settings saved.");
      setError(null);
      alerts.refetch();
    },
    onError: (err: Error) => setError(err.message),
  });

  const addWebhook = useMutation({
    mutationFn: () =>
      apiSend<{ webhook: WebhookView }>("POST", "/api/alerts/webhooks", {
        url: whUrl.trim(),
        secret: whSecret.trim() === "" ? undefined : whSecret.trim(),
        events: whEvents,
      }),
    onSuccess: () => {
      setWhUrl("");
      setWhSecret("");
      setWhError(null);
      webhooks.refetch();
    },
    onError: (err: Error) => setWhError(err.message),
  });

  const toggleWebhook = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiSend("PATCH", `/api/alerts/webhooks/${id}`, { enabled }),
    onSuccess: () => webhooks.refetch(),
  });

  const deleteWebhook = useMutation({
    mutationFn: (id: string) => apiSend("DELETE", `/api/alerts/webhooks/${id}`),
    onSuccess: () => webhooks.refetch(),
  });

  const sendTest = useMutation<
    {
      email: { success: boolean; error?: string };
      webhooks: { delivered: number; failed: number } | null;
    },
    Error
  >({
    mutationFn: () => apiSend("POST", "/api/alerts/test"),
    onSuccess: (data) => {
      const emailOk = data.email?.success
        ? "Test email sent."
        : `Test email failed${data.email?.error ? `: ${data.email.error}` : ""}.`;
      setTestMsg(
        data.webhooks == null
          ? `${emailOk} No webhooks configured.`
          : `${emailOk} Webhooks delivered: ${data.webhooks.delivered}, failed: ${data.webhooks.failed}.`,
      );
      setTestErr(null);
      events.refetch();
    },
    onError: (err: Error) => {
      setTestErr(err.message);
      setTestMsg(null);
    },
  });

  if (status.isLoading || alerts.isLoading)
    return <Spinner label="Loading settings…" />;
  if (status.error)
    return (
      <EmptyState
        title="Could not load settings"
        description={status.error.message}
      />
    );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500">
          Spend limits, alerting and your tenant base URL for this organization.
        </p>
      </div>

      <Card
        title="Tenant base URL"
        subtitle="Your OpenAI-compatible proxy endpoint. Non-root tenants must use their prefix; the root tenant uses the plain path."
        actions={<Globe size={16} className="text-gray-400" />}
      >
        {tenant.isLoading ? (
          <Spinner label="Loading tenant…" />
        ) : tenant.data ? (
          <div className="space-y-4">
            {!tenant.data.isRoot && tenant.data.systemPrefix && (
              <div>
                <Label>System prefix (assigned, read-only)</Label>
                <code className="block w-fit rounded-md bg-gray-100 px-3 py-2 font-mono text-xs text-gray-700">
                  /{tenant.data.systemPrefix}/v1/chat/completions
                </code>
              </div>
            )}
            <div className="max-w-md">
              <Label>Custom prefix</Label>
              <Input
                placeholder={
                  tenant.data.isRoot
                    ? "empty (root path)"
                    : `e.g. ${tenant.data.systemPrefix ?? "myorg"}`
                }
                value={customPrefix}
                onChange={(e) => setCustomPrefix(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-gray-400">
                {tenant.data.isRoot
                  ? "Leave empty to use the plain path (your org owns it)."
                  : "Lowercase letters, digits and dashes (min 6 chars). Setting it overrides the system prefix."}
              </p>
            </div>
            {prefixErr && <p className="text-sm text-red-600">{prefixErr}</p>}
            {prefixMsg && <p className="text-sm text-green-700">{prefixMsg}</p>}
            <div className="flex items-center gap-2">
              <Button
                onClick={() => savePrefix.mutate()}
                loading={savePrefix.isPending}
              >
                Save prefix
              </Button>
              {tenant.data.isRoot && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setCustomPrefix("");
                    setPrefixErr(null);
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
            <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
              <p className="text-xs font-medium text-gray-500">
                Effective endpoint
              </p>
              <code className="mt-1 block break-all font-mono text-xs text-gray-800">
                {window.location.origin}
                {tenant.data.basePath ? `/${tenant.data.basePath}` : ""}
                /v1/chat/completions
              </code>
            </div>
          </div>
        ) : (
          <EmptyState
            title="Could not load tenant"
            description={tenant.error?.message ?? "Unknown error"}
          />
        )}
      </Card>

      <Card
        title="Spend limits"
        subtitle="Auto-disable proxy traffic when a window's spend crosses its limit."
        actions={<ShieldAlert size={16} className="text-gray-400" />}
      >
        {status.data?.daily?.breached || status.data?.monthly?.breached ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            A spend limit has been reached. Keys are currently disabled until
            the window resets.
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label>Daily limit (USD)</Label>
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="e.g. 20"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
            />
            {status.data?.daily?.limitUsd != null && (
              <p className="mt-1 text-[11px] text-gray-400">
                Current daily spend: {fmtUsd(status.data.daily.usageUsd)}
              </p>
            )}
          </div>
          <div>
            <Label>Monthly limit (USD)</Label>
            <Input
              type="number"
              min="0"
              step="1"
              placeholder="e.g. 500"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
            />
            {status.data?.monthly?.limitUsd != null && (
              <p className="mt-1 text-[11px] text-gray-400">
                Current monthly spend: {fmtUsd(status.data.monthly.usageUsd)}
              </p>
            )}
          </div>
        </div>

        <p className="mt-3 text-[11px] text-gray-400">
          Leave blank to remove a limit. Changes take effect immediately.
        </p>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {message && <p className="mt-3 text-sm text-green-700">{message}</p>}

        <div className="mt-4">
          <Button
            onClick={() => saveLimits.mutate()}
            loading={saveLimits.isPending}
          >
            Save limits
          </Button>
        </div>
      </Card>

      <Card
        title="Alerts"
        subtitle="Evaluate spend and error-rate thresholds every 5 minutes; deliver by email and webhook."
        actions={<BellRing size={16} className="text-gray-400" />}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={alertsForm.enabled}
                onChange={(e) =>
                  setAlertsForm({ ...alertsForm, enabled: e.target.checked })
                }
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              Alerting enabled
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={alertsForm.emailEnabled}
                onChange={(e) =>
                  setAlertsForm({
                    ...alertsForm,
                    emailEnabled: e.target.checked,
                  })
                }
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              Email owners/admins
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <Label>Error rate threshold %</Label>
              <Input
                type="number"
                min="1"
                max="100"
                value={alertsForm.errorThresholdPct}
                onChange={(e) =>
                  setAlertsForm({
                    ...alertsForm,
                    errorThresholdPct: Number(e.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label>Min requests</Label>
              <Input
                type="number"
                min="1"
                value={alertsForm.errorMinRequests}
                onChange={(e) =>
                  setAlertsForm({
                    ...alertsForm,
                    errorMinRequests: Number(e.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label>Window (min)</Label>
              <Input
                type="number"
                min="5"
                value={alertsForm.errorWindowMinutes}
                onChange={(e) =>
                  setAlertsForm({
                    ...alertsForm,
                    errorWindowMinutes: Number(e.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label>Cooldown (min)</Label>
              <Input
                type="number"
                min="5"
                value={alertsForm.cooldownMinutes}
                onChange={(e) =>
                  setAlertsForm({
                    ...alertsForm,
                    cooldownMinutes: Number(e.target.value),
                  })
                }
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {message && <p className="text-sm text-green-700">{message}</p>}

          <div className="flex items-center gap-2">
            <Button
              onClick={() => saveAlerts.mutate()}
              loading={saveAlerts.isPending}
            >
              Save alert settings
            </Button>
            <Button
              variant="outline"
              onClick={() => sendTest.mutate()}
              loading={sendTest.isPending}
            >
              Send test alert
            </Button>
          </div>
          {testErr && <p className="text-sm text-red-600">{testErr}</p>}
          {testMsg && <p className="text-sm text-green-700">{testMsg}</p>}
        </div>
      </Card>

      <Card
        title="Webhook subscriptions"
        subtitle="POST alert payloads to external URLs (optionally HMAC-signed with a secret)."
        actions={<Zap size={16} className="text-gray-400" />}
      >
        <div className="space-y-4">
          {webhooks.data?.length ? (
            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
              {webhooks.data.map((wh) => (
                <li
                  key={wh.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-800">
                      {wh.url}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge tone={wh.enabled ? "green" : "gray"}>
                        {wh.enabled ? "enabled" : "disabled"}
                      </Badge>
                      {wh.events.map((ev) => (
                        <Badge key={ev} tone="blue">
                          {ev}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        toggleWebhook.mutate({
                          id: wh.id,
                          enabled: !wh.enabled,
                        })
                      }
                    >
                      {wh.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => deleteWebhook.mutate(wh.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">
              No webhook subscriptions yet.
            </p>
          )}

          <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <Label>Webhook URL</Label>
                <Input
                  placeholder="https://monitoring.example.com/ingest"
                  value={whUrl}
                  onChange={(e) => setWhUrl(e.target.value)}
                />
              </div>
              <div>
                <Label>Secret (optional, HMAC)</Label>
                <Input
                  placeholder="shared secret"
                  value={whSecret}
                  onChange={(e) => setWhSecret(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-3">
              <Label>Events</Label>
              <Select
                multiple
                className="w-full"
                value={whEvents}
                onChange={(v) => setWhEvents(v as string[])}
                options={[
                  { value: "quota_exceeded", label: "quota_exceeded" },
                  { value: "high_error_rate", label: "high_error_rate" },
                  { value: "test", label: "test" },
                ]}
              />
            </div>
            {whError && <p className="mt-2 text-sm text-red-600">{whError}</p>}
            <div className="mt-3">
              <Button
                onClick={() => addWebhook.mutate()}
                loading={addWebhook.isPending}
              >
                Add webhook
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Recent alerts"
        subtitle="Latest alert deliveries for this organization."
        actions={<BellRing size={16} className="text-gray-400" />}
      >
        {events.isLoading ? (
          <Spinner label="Loading events…" />
        ) : events.data?.length ? (
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {events.data.map((ev) => (
              <li
                key={ev.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800">
                    {ev.eventType}
                    {ev.provider ? ` · ${ev.provider}` : ""}
                    <span className="ml-1 text-xs text-gray-400">
                      level {ev.level}
                    </span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {new Date(ev.createdAt * 1000).toLocaleString()} ·{" "}
                    {ev.channel}
                  </p>
                </div>
                <Badge tone={ev.status === "sent" ? "green" : "red"}>
                  {ev.status}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500">
            No alerts have been triggered yet.
          </p>
        )}
      </Card>
    </div>
  );
}
