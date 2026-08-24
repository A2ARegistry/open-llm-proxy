#!/usr/bin/env node
/**
 * Production deploy wrapper for open-source forks.
 *
 * `wrangler.jsonc` intentionally ships placeholder resource IDs (this is a
 * public repo). This wrapper injects your REAL D1 / KV IDs at deploy time and
 * writes a local, git-ignored config (`wrangler.production.local.json`), then
 * runs migrations + `wrangler deploy --env production` against it.
 *
 * Usage:
 *   npm run deploy -- --d1 <database_id> --kv <namespace_id>
 *
 * Flags:
 *   --d1 <id>        D1 database_id for env.production   (or env D1_DATABASE_ID)
 *   --d1-name <name> Override database_name              (default: from config)
 *   --kv <id>        KV namespace id for SESSION_CACHE   (or env KV_NAMESPACE_ID)
 *   --migrate-only   Apply D1 migrations and exit
 *   --skip-migrate   Deploy without applying migrations
 *   --skip-build     Skip `npm run build` (tsc + dashboard)
 *   --dry-run        Print what would run; write nothing
 *
 * Anything after the flags is passed through to `wrangler deploy`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const SOURCE_CONFIG = "wrangler.jsonc";
const GENERATED_CONFIG = "wrangler.production.local.json";
const PLACEHOLDER_D1 = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_KV = "00000000000000000000000000000000";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_ID_RE = /^[0-9a-f]{32}$/i;

const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

/** String-aware JSONC comment stripper (naive regex breaks URLs in strings). */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function run(cmd, args, { capture = false } = {}) {
  console.log(`▶ ${[cmd, ...args].join(" ")}`);
  const res = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (res.status !== 0) {
    die(`command failed (exit ${res.status}): ${cmd} ${args.join(" ")}`);
  }
  return res.stdout?.toString() ?? "";
}

const { values: opts, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        d1: { type: "string" },
        "d1-name": { type: "string" },
        kv: { type: "string" },
        "migrate-only": { type: "boolean", default: false },
        "skip-build": { type: "boolean", default: false },
        "skip-migrate": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
      },
    });
  } catch (err) {
    die(err.message);
  }
})();

const d1Id = opts.d1 ?? process.env.D1_DATABASE_ID;
const kvId = opts.kv ?? process.env.KV_NAMESPACE_ID;

if (!existsSync(SOURCE_CONFIG)) die(`${SOURCE_CONFIG} not found`);
const cfg = JSON.parse(stripJsonComments(readFileSync(SOURCE_CONFIG, "utf8")));
const prod = cfg.env?.production;
if (!prod) die(`${SOURCE_CONFIG} has no env.production section`);

if (!prod.d1_databases?.length) die("env.production.d1_databases is empty");
if (!prod.kv_namespaces?.length) die("env.production.kv_namespaces is empty");
const d1Binding = prod.d1_databases[0];
const kvBinding = prod.kv_namespaces[0];

// Resolve final values (CLI flag > env var > existing non-placeholder value).
const nextD1 = d1Id ?? d1Binding.database_id;
const nextKv = kvId ?? kvBinding.id;
if (!nextD1 || nextD1 === PLACEHOLDER_D1) {
  die(
    "Missing real D1 database id. Pass --d1 <id> (or set D1_DATABASE_ID). Find it via `npx wrangler d1 list` or the Cloudflare dashboard.",
  );
}
if (!UUID_RE.test(nextD1)) {
  die(`--d1 does not look like a UUID: "${nextD1}"`);
}
if (!opts["migrate-only"] && (!nextKv || nextKv === PLACEHOLDER_KV)) {
  die(
    "Missing real KV namespace id. Pass --kv <id> (or set KV_NAMESPACE_ID). Find it via `npx wrangler kv namespace list` or the Cloudflare dashboard.",
  );
}
if (nextKv && nextKv !== PLACEHOLDER_KV && !KV_ID_RE.test(nextKv)) {
  die(`--kv does not look like a namespace id (32 hex chars): "${nextKv}"`);
}

d1Binding.database_id = nextD1;
if (opts["d1-name"]) d1Binding.database_name = opts["d1-name"];
kvBinding.id = nextKv;

if (opts["migrate-only"]) {
  console.log("D1 : %s (%s)", d1Binding.database_name, nextD1);
  console.log("KV : skipped (--migrate-only)");
} else {
  console.log(`\nD1 : ${d1Binding.database_name} (${nextD1})`);
  console.log(`KV : ${kvBinding.binding} (${nextKv})`);
}

const generated = { ...cfg, $schema: undefined };
delete generated.$schema;
const generatedText = JSON.stringify(generated, null, 2);

const wranglerArgs = ["--env", "production", "--config", GENERATED_CONFIG];

if (opts["dry-run"]) {
  const skipBuild = opts["skip-build"] || opts["migrate-only"];
  console.log(`\n[dry-run] would write ${GENERATED_CONFIG}`);
  console.log(
    `[dry-run] would run: npm run build${skipBuild ? " (skipped)" : ""}`,
  );
  if (!opts["skip-migrate"] && !opts["migrate-only"]) {
    console.log(
      `[dry-run] would run: npx wrangler d1 migrations apply DB --remote ${wranglerArgs.join(" ")}`,
    );
  }
  if (!opts["migrate-only"]) {
    console.log(
      `[dry-run] would run: npx wrangler deploy ${wranglerArgs.join(" ")}${positionals.length ? " " + positionals.join(" ") : ""}`,
    );
  }
  process.exit(0);
}

writeFileSync(GENERATED_CONFIG, generatedText + "\n");

try {
  // Build first: the deploy needs dashboard/dist as static assets.
  if (!opts["skip-build"] && !opts["migrate-only"]) {
    run("npm", ["run", "build"]);
  }

  if (!opts["skip-migrate"]) {
    run("npx", [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--remote",
      ...wranglerArgs,
    ]);
  }

  if (!opts["migrate-only"]) {
    run("npx", ["wrangler", "deploy", ...wranglerArgs, ...positionals]);
  }
} finally {
  // Best-effort cleanup of the git-ignored generated config.
  try {
    unlinkSync(GENERATED_CONFIG);
  } catch {
    /* ignore */
  }
}

console.log("\n✔ Done.");
