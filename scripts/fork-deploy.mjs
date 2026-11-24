// [fork] W9: deploy-time options for the fork (see FORK.md).
// Pure helpers, no Node APIs, so they are unit-tested in the Workers pool.

const BINDING_RE = /^[A-Z][A-Z0-9_]*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_RE = /^[A-Za-z0-9_-]+$/;
const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function splitPair(raw, flag) {
  const at = raw.indexOf("=");
  if (at <= 0 || at === raw.length - 1) {
    throw new Error(`${flag} expects NAME=ID, got "${raw}"`);
  }
  return [raw.slice(0, at), raw.slice(at + 1)];
}

function parseServices(list) {
  const services = new Map();
  for (const raw of list) {
    const [name, id] = splitPair(raw, "--vpc-service-id");
    if (!BINDING_RE.test(name)) {
      throw new Error(`--vpc-service-id: invalid binding name "${name}"`);
    }
    if (!UUID_RE.test(id)) {
      throw new Error(`--vpc-service-id: invalid service id for ${name}`);
    }
    if (services.has(name)) {
      throw new Error(`--vpc-service-id: ${name} given twice`);
    }
    services.set(name, id);
  }
  return services;
}

function parseAllow(list, services) {
  const allow = new Map();
  for (const raw of list) {
    const [name, orgs] = splitPair(raw, "--vpc-allow");
    if (!services.has(name)) {
      throw new Error(`--vpc-allow: unknown VPC service "${name}"`);
    }
    const ids = orgs.split("|");
    if (!ids.every((id) => id === "*" || ORG_RE.test(id))) {
      throw new Error(`--vpc-allow: invalid organization id in "${raw}"`);
    }
    allow.set(name, ids.join("|"));
  }
  return allow;
}

/**
 * Apply the fork's deploy options to the production env config, in place.
 *
 * - `vpcServiceIds`: ["NAME=SERVICE_UUID", ...] → `vpc_services` entries.
 * - `vpcAllow`: ["NAME=org_a|org_b" | "NAME=*", ...] → `VPC_BINDINGS`.
 *   A service without one is listed bare, which allows nobody.
 * - `customDomain`: "api.example.com" → custom-domain route, and
 *   workers.dev / preview URLs off.
 *
 * @returns {{ warnings: string[] }}
 * @throws Error on any malformed option.
 */
export function applyForkOptions(prod, options) {
  const warnings = [];
  const services = parseServices(options.vpcServiceIds ?? []);
  const allow = parseAllow(options.vpcAllow ?? [], services);

  if (services.size > 0) {
    prod.vpc_services = [...services].map(([binding, service_id]) => ({
      binding,
      service_id,
      remote: true,
    }));
    prod.vars ??= {};
    prod.vars.VPC_BINDINGS = [...services.keys()]
      .map((name) => (allow.has(name) ? `${name}:${allow.get(name)}` : name))
      .join(",");
    for (const name of services.keys()) {
      if (!allow.has(name)) {
        warnings.push(
          `${name} has no --vpc-allow, so no organization can use it yet`,
        );
      }
    }
  }

  if (options.customDomain !== undefined) {
    if (!HOST_RE.test(options.customDomain)) {
      throw new Error(
        `--custom-domain: invalid custom domain "${options.customDomain}" (hostname only, e.g. api.example.com)`,
      );
    }
    prod.routes = [{ pattern: options.customDomain, custom_domain: true }];
    prod.workers_dev = false;
    prod.preview_urls = false;
  }

  return { warnings };
}

function envList(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Resolve the fork's deploy options: CLI flag first, then env var.
 * Env vars exist for Git builds (Workers Builds), which cannot pass flags.
 *
 * - VPC_SERVICE_IDS: "NAME=ID,NAME=ID"
 * - VPC_ALLOW: "NAME=org_a|org_b,NAME=*"
 * - CUSTOM_DOMAIN: "api.example.com"
 * - ZERO_PRICE_PROVIDERS: "provider-a,provider-b"
 */
export function forkOptionsFromEnv(flags, env) {
  const customDomain = (flags["custom-domain"] ?? env.CUSTOM_DOMAIN)?.trim();
  return {
    vpcServiceIds: flags["vpc-service-id"] ?? envList(env.VPC_SERVICE_IDS),
    vpcAllow: flags["vpc-allow"] ?? envList(env.VPC_ALLOW),
    customDomain: customDomain || undefined,
    zeroPriceProviders:
      flags["zero-price-provider"] ?? envList(env.ZERO_PRICE_PROVIDERS),
  };
}

/** SQL that prices every model of `provider` at 0 (provider-wide '*' row). */
export function zeroPriceSql(provider) {
  if (!PROVIDER_RE.test(provider)) {
    throw new Error(`--zero-price-provider: invalid provider id "${provider}"`);
  }
  return `INSERT OR REPLACE INTO model_pricing (provider, model, input_per_1m, output_per_1m, cache_read_per_1m, cache_write_per_1m) VALUES ('${provider}', '*', 0, 0, 0, 0);`;
}
