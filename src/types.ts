import { Env } from "../worker-configuration.d";
import { AppAuth } from "./auth/setup";
import { TenantSettings } from "./db/tenant";

export interface ApiKeyScopes {
  providers?: string[];
  models?: string[];
  spendCapUsd?: number;
  ipAllowlist?: string[];
}

export interface ApiKeyAuth {
  keyId: string;
  organizationId: string;
  name: string;
  scopes: ApiKeyScopes;
  keyPrefix: string;
  spendDisabledUntil: number | null;
}

export interface SessionAuth {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  role: string | null;
  email: string;
  expiresAt: number;
}

export interface AppBindings {
  Bindings: Env;
  Variables: AppVariables;
}

export interface AppVariables {
  auth?: AppAuth;
  session?: SessionAuth;
  apiKeyAuth?: ApiKeyAuth;
  tenantSettings?: TenantSettings;
  requestId?: string;
}
