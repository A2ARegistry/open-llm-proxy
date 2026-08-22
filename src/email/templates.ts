import { nowSeconds } from "../utils/crypto";

export interface SeedTemplate {
  template_id: string;
  template_name: string;
  template_type: string;
  subject_template: string;
  body_markdown: string;
  variables: string[];
  description: string;
}

export const SEED_TEMPLATES: SeedTemplate[] = [
  {
    template_id: "verify_email",
    template_name: "Email Verification",
    template_type: "auth",
    subject_template: "Verify your email",
    body_markdown: `Hi {{user_name}},

Welcome to {{brand_name}}! Please verify your email address to activate your account.

Click the button below to confirm your email:

[Verify my email]({{url}})

If you didn't create an account with {{brand_name}}, you can safely ignore this email.

Thanks,\nThe {{brand_name}} team`,
    variables: ["user_name", "brand_name", "url"],
    description: "Sent on signup when email verification is required",
  },
  {
    template_id: "reset_password",
    template_name: "Password Reset",
    template_type: "auth",
    subject_template: "Reset your password",
    body_markdown: `Hi {{user_name}},

We received a request to reset your password for {{brand_name}}.

Click the button below to choose a new password:

[Reset my password]({{url}})

This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.

Thanks,\nThe {{brand_name}} team`,
    variables: ["user_name", "brand_name", "url"],
    description: "Sent when a user requests a password reset",
  },
  {
    template_id: "invite",
    template_name: "Team Invitation",
    template_type: "auth",
    subject_template: "You've been invited to join {{organization_name}}",
    body_markdown: `Hi there,

{{inviter_name}} has invited you to join the **{{organization_name}}** organization on {{brand_name}} with the role of **{{role}}**.

Click the button below to accept the invitation:

[Accept invitation]({{url}})

If you don't have an account yet, you'll be able to create one when you accept.

Thanks,\nThe {{brand_name}} team`,
    variables: [
      "inviter_name",
      "organization_name",
      "brand_name",
      "role",
      "url",
    ],
    description: "Sent when a team member is invited to an organization",
  },
  {
    template_id: "quota_exceeded",
    template_name: "Spending Limit Reached",
    template_type: "notification",
    subject_template: "Spending limit reached ({{percent}}%)",
    body_markdown: `Hi {{user_name}},

Your organization **{{organization_name}}** has reached **{{percent}}%** of its monthly spending limit.

Current spend: **{{current_spend}}**
Limit: **{{limit}}**

{{#suspended}}Your API access has been suspended until the limit is raised.{{/suspended}}

Manage your limits in the dashboard.

Thanks,\nThe {{brand_name}} team`,
    variables: [
      "user_name",
      "organization_name",
      "brand_name",
      "percent",
      "current_spend",
      "limit",
      "suspended",
    ],
    description: "Sent as the tenant approaches or exceeds its spending limit",
  },
  {
    template_id: "high_error_rate",
    template_name: "High Error Rate Alert",
    template_type: "notification",
    subject_template: "Alert: high error rate ({{error_rate}}%)",
    body_markdown: `Hi {{user_name}},

Your organization **{{organization_name}}** has experienced a high error rate on the Open LLM Proxy.

Provider: **{{provider}}**
Error rate: **{{error_rate}}%** over the last {{window_minutes}} minutes.

Please check your provider configuration and credentials.

Thanks,\nThe {{brand_name}} team`,
    variables: [
      "user_name",
      "organization_name",
      "brand_name",
      "provider",
      "error_rate",
      "window_minutes",
    ],
    description:
      "Sent when the provider error rate exceeds the alert threshold",
  },
  {
    template_id: "welcome",
    template_name: "Welcome",
    template_type: "auth",
    subject_template: "Welcome to {{brand_name}}",
    body_markdown: `Hi {{user_name}},

Welcome to {{brand_name}}! Your account and organization **{{organization_name}}** are ready to use.

Next steps:
1. Add your first provider API key in the dashboard
2. Create an API key for programmatic access
3. Make your first request to the Open LLM Proxy

Get started: {{portal_url}}

Thanks,\nThe {{brand_name}} team`,
    variables: ["user_name", "brand_name", "organization_name", "portal_url"],
    description: "Sent to a new user after their first organization is created",
  },
];

/** Seed templates idempotently (upsert by template_id). */
export async function seedTemplates(env: Env): Promise<number> {
  try {
    const batch = SEED_TEMPLATES.map((t) =>
      env.DB.prepare(
        `INSERT INTO system_email_templates
          (template_id, template_name, template_type, subject_template, body_markdown, variables, description, is_active, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')
         ON CONFLICT(template_id) DO UPDATE SET
           template_name = excluded.template_name,
           template_type = excluded.template_type,
           subject_template = excluded.subject_template,
           body_markdown = excluded.body_markdown,
           variables = excluded.variables,
           description = excluded.description,
           is_active = 1,
           updated_at = excluded.updated_at`,
      ).bind(
        t.template_id,
        t.template_name,
        t.template_type,
        t.subject_template,
        t.body_markdown,
        JSON.stringify(t.variables),
        t.description,
        nowSeconds(),
        nowSeconds(),
      ),
    );
    await env.DB.batch(batch);
    console.log(`[seedTemplates] Successfully seeded ${SEED_TEMPLATES.length} templates`);
    return SEED_TEMPLATES.length;
  } catch (error) {
    console.error('[seedTemplates] Failed to seed templates:', error);
    throw error;
  }
}
