import { Card } from "../components/ui";
import { apiGet, apiSend } from "../lib/api";
import {
  EmailLogsPanel,
  EmailSettings,
  TemplateManager,
} from "@contentgrowth/content-emailing/frontend";
import type {
  EmailSettingsData,
  EmailTemplate,
  TemplateFormData,
} from "@contentgrowth/content-emailing/frontend";

interface LogsResponse {
  logs: Record<string, unknown>[];
  total: number;
}

const fetchLogs = async (params: {
  page: number;
  limit: number;
  status?: string;
  email?: string;
  template?: string;
}) => {
  const q = new URLSearchParams({
    limit: String(params.limit),
    offset: String((params.page - 1) * params.limit),
  });
  if (params.status) q.set("status", params.status);
  if (params.email) q.set("email", params.email);
  if (params.template) q.set("template", params.template);
  const res = await apiGet<LogsResponse>(`/api/email/logs?${q.toString()}`);
  const logs = res.logs.map((l) => ({
    id: String(l.id ?? ""),
    recipientEmail: String(l.recipient_email ?? l.recipientEmail ?? ""),
    recipientUserId: l.recipient_user_id
      ? String(l.recipient_user_id)
      : undefined,
    templateId: String(l.template_id ?? l.templateId ?? ""),
    subject: l.subject ? String(l.subject) : undefined,
    status: String(l.status ?? "sent") as
      "sent" | "pending" | "failed" | "bounced" | "complained",
    provider: l.provider ? String(l.provider) : undefined,
    providerMessageId: l.provider_message_id
      ? String(l.provider_message_id)
      : undefined,
    errorMessage: l.error_message ? String(l.error_message) : undefined,
    createdAt: Number(l.created_at ?? l.createdAt ?? 0),
    sentAt: l.sent_at ? Number(l.sent_at) : undefined,
  }));
  return { logs, total: res.total };
};

async function loadTemplates(): Promise<EmailTemplate[]> {
  const res = await apiGet<{ templates: EmailTemplate[] }>(
    "/api/email/templates",
  );
  return res.templates;
}

async function saveTemplate(data: TemplateFormData): Promise<void> {
  await apiSend("POST", "/api/email/templates", data);
}

async function deleteTemplate(id: string): Promise<void> {
  await apiSend("DELETE", `/api/email/templates/${id}`);
}

async function sendTestEmail(data: {
  template_id: string;
  to: string;
  variables: Record<string, string>;
}): Promise<void> {
  await apiSend("POST", `/api/email/templates/${data.template_id}/test`, {
    to: data.to,
    data: data.variables,
  });
}

async function loadSettings(): Promise<EmailSettingsData> {
  const res = await apiGet<{ settings: EmailSettingsData }>(
    "/api/email/settings",
  );
  return res.settings;
}

async function saveSettings(settings: EmailSettingsData): Promise<void> {
  await apiSend("POST", "/api/email/settings", settings);
}

export function EmailPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Email</h1>
        <p className="text-sm text-gray-500">
          Templates, sending settings, and delivery logs.
        </p>
      </div>

      <Card title="Settings" subtitle="Tenant-specific sending configuration">
        <EmailSettings
          onLoadSettings={loadSettings}
          onSaveSettings={saveSettings}
          onTestSettings={async () => ({
            success: false,
            message: "Test sending is done from the template tester.",
          })}
        />
      </Card>

      <TemplateManager
        onLoadTemplates={loadTemplates}
        onSaveTemplate={saveTemplate}
        onDeleteTemplate={deleteTemplate}
        onSendTestEmail={sendTestEmail}
        templateTypes={[
          "auth",
          "notification",
          "system",
          "invitation",
          "verification",
          "marketing",
        ]}
      />

      <Card title="Logs" subtitle="Recent transactional email deliveries">
        <EmailLogsPanel fetchLogs={fetchLogs} pageSize={20} />
      </Card>
    </div>
  );
}
