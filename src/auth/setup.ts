import { auditLog } from "../audit/audit-logger";
import { getAuthSecret } from "../bootstrap/secrets";
import { sendTemplateEmail } from "../email/service";
import { handleSignup } from "../tenants/onboarding";
import { normalizeConfiguredUrl } from "../utils/base-url";
import { createAuth } from "@contentgrowth/content-auth/backend";
import { organization } from "better-auth/plugins";

export interface AuthEmailContext {
  env: Env;
  brandName: string;
  baseUrl: string;
}

export function buildAuthEmailCallbacks(ctx: AuthEmailContext) {
  const sendVerificationEmail = async (data: {
    user: { id: string; email: string; name?: string };
    url: string;
    token: string;
  }) => {
    await sendTemplateEmail(ctx.env, {
      templateId: "verify_email",
      to: data.user.email,
      data: {
        user_name: data.user.name || data.user.email,
        brand_name: ctx.brandName,
        url: data.url,
      },
      metadata: { kind: "verify_email" },
      userId: data.user.id,
    });
  };

  const sendResetPassword = async (data: {
    user: { id: string; email: string; name?: string };
    url: string;
    token: string;
  }) => {
    await sendTemplateEmail(ctx.env, {
      templateId: "reset_password",
      to: data.user.email,
      data: {
        user_name: data.user.name || data.user.email,
        brand_name: ctx.brandName,
        url: data.url,
      },
      metadata: { kind: "reset_password" },
      userId: data.user.id,
    });
  };

  const sendInvitationEmail = async (data: {
    id: string;
    role: string;
    email: string;
    organization: { name: string };
    invitation: { inviterId: string };
    inviter: { user?: { name?: string } } | { id: string };
  }) => {
    const inviterName =
      "user" in data.inviter ? data.inviter.user?.name : undefined;
    await sendTemplateEmail(ctx.env, {
      templateId: "invite",
      to: data.email,
      data: {
        inviter_name: inviterName || "A team member",
        organization_name: data.organization.name,
        brand_name: ctx.brandName,
        role: data.role,
        url: `${ctx.baseUrl}/accept-invitation?id=${data.id}`,
      },
      metadata: { kind: "invite", invitationId: data.id },
      userId: data.invitation.inviterId,
    });
  };

  return { sendVerificationEmail, sendResetPassword, sendInvitationEmail };
}

export type AppAuth = ReturnType<typeof createAuth>;

const authCache = new WeakMap<Env, Map<string, Promise<AppAuth>>>();
/** Bound per-isolate cache entries so untrusted origins can't grow it forever. */
const AUTH_CACHE_MAX_KEYS = 16;

/**
 * Create (cached) a Better Auth instance wired to our D1 + tenant onboarding +
 * emailing. The signing secret is auto-generated and persisted in
 * `system_settings` on first boot (override with a `BETTER_AUTH_SECRET` env).
 *
 * `requestOrigin` is the origin serving the current request. It is always
 * included in the trusted origins, and when `BASE_URL` is unset (or still a
 * public-repo placeholder) it also becomes the effective base URL — so
 * sign-in, email links, and cookies work out of the box on whatever domain
 * Cloudflare assigns, without any configuration.
 */
export function getAuthFor(env: Env, requestOrigin?: string): Promise<AppAuth> {
  const baseUrl =
    normalizeConfiguredUrl(env.BASE_URL) ??
    requestOrigin ??
    "http://localhost:8787";
  const dashboardUrl = normalizeConfiguredUrl(env.DASHBOARD_URL) ?? baseUrl;
  // Same-origin requests are safe to accept: browsers control the Origin
  // header, so a cross-site attacker's Origin can never equal our host.
  const trusted = [
    ...new Set(
      [baseUrl, dashboardUrl, requestOrigin].filter((o): o is string =>
        Boolean(o),
      ),
    ),
  ];

  let byKey = authCache.get(env);
  if (!byKey) {
    byKey = new Map();
    authCache.set(env, byKey);
  }
  const cacheKey = `${baseUrl}|${dashboardUrl}|${requestOrigin ?? ""}`;
  let cached = byKey.get(cacheKey);
  if (!cached) {
    if (byKey.size >= AUTH_CACHE_MAX_KEYS && !byKey.has(cacheKey)) {
      const oldest = byKey.keys().next().value;
      if (oldest !== undefined) byKey.delete(oldest);
    }
    cached = buildAuth(env, { baseUrl, trusted });
    byKey.set(cacheKey, cached);
  }
  return cached;
}

async function buildAuth(
  env: Env,
  urls: { baseUrl: string; trusted: string[] },
): Promise<AppAuth> {
  const brandName = env.APP_NAME || "Open LLM Proxy";
  const secret = await getAuthSecret(env);
  const baseUrl = urls.baseUrl;
  const { sendVerificationEmail, sendResetPassword, sendInvitationEmail } =
    buildAuthEmailCallbacks({ env, brandName, baseUrl });

  return createAuth({
    database: env.DB,
    secret,
    baseUrl,
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail,
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: true,
      sendResetPassword,
    },
    turnstile: (env as any).TURNSTILE_SECRET
      ? { secretKey: (env as any).TURNSTILE_SECRET! }
      : undefined,
    emailNormalization: { enabled: true },
    signInTracking: { enabled: true },
    onSignup: (user) => handleSignup(env, user),
    onSignin: (user) =>
      auditLog(env, {
        organizationId: null,
        userId: user.id,
        action: "auth",
        resourceType: "session",
        details: { event: "signin" },
      }),
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
        sendInvitationEmail,
        roles: {
          viewer: {} as any,
        },
      }),
    ],
    trustedOrigins: urls.trusted,
  });
}
