// [fork] W12: which providers reach the self-hosted box, per organization.
// Only the plaintext `settings` of provider_configs are read; keys stay encrypted.
import { isAllowed, parseAllowlist } from "../llm/transport";

export interface VpcProvider {
  organizationId: string;
  provider: string;
  binding: string;
}

interface Row {
  organization_id: string;
  provider: string;
  binding: string | null;
}

/** Providers with vpc transport whose binding `VPC_BINDINGS` allows for the org. */
export async function vpcProviders(
  env: Env,
  organizationId?: string,
): Promise<VpcProvider[]> {
  const allowlist = parseAllowlist(
    (env as unknown as Record<string, unknown>).VPC_BINDINGS,
  );
  const scoped = organizationId === undefined ? "" : "AND organization_id = ?";
  const stmt = env.DB.prepare(
    `SELECT organization_id, provider,
            json_extract(config, '$.settings.vpcBinding') AS binding
       FROM provider_configs
      WHERE json_extract(config, '$.settings.transport') = 'vpc' ${scoped}`,
  );
  const { results } = await (
    organizationId === undefined ? stmt : stmt.bind(organizationId)
  ).all<Row>();
  return results.flatMap((row) =>
    row.binding && isAllowed(allowlist, row.binding, row.organization_id)
      ? [
          {
            organizationId: row.organization_id,
            provider: row.provider,
            binding: row.binding,
          },
        ]
      : [],
  );
}

/** The VPC binding `provider` uses for `orgId`, or null if it is not a vpc provider. */
export async function providerVpcBinding(
  env: Env,
  orgId: string,
  provider: string,
): Promise<string | null> {
  const providers = await vpcProviders(env, orgId);
  return providers.find((p) => p.provider === provider)?.binding ?? null;
}
