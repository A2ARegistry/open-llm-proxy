import { Spinner } from "../components/ui";
import { authClient } from "@contentgrowth/content-auth";
import {
  ArrowRight,
  BarChart3,
  Boxes,
  Gauge,
  Github,
  KeyRound,
  ShieldCheck,
  Star,
  Users,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

// Default repository; operators can override it with the `GITHUB_REPO_URL`
// worker var (exposed via /api/bootstrap/status).
const DEFAULT_REPO_URL = "https://github.com/A2ARegistry/open-llm-proxy";

type SessionState = "loading" | "authed" | "guest";

function useSessionState(): SessionState {
  const [state, setState] = useState<SessionState>("loading");
  useEffect(() => {
    let alive = true;
    authClient
      .getSession()
      .then(({ data }) => {
        if (alive) setState(data?.session ? "authed" : "guest");
      })
      .catch(() => alive && setState("guest"));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** Repository URL: `GITHUB_REPO_URL` var when set, otherwise the default. */
function useRepoUrl(): string {
  const [repoUrl, setRepoUrl] = useState(DEFAULT_REPO_URL);
  useEffect(() => {
    let alive = true;
    fetch("/api/bootstrap/status")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (s: { githubRepoUrl?: string } | null) =>
          alive && s?.githubRepoUrl && setRepoUrl(s.githubRepoUrl),
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return repoUrl;
}

const FEATURES = [
  {
    icon: Zap,
    title: "Unified OpenAI-compatible API",
    body: "Swap providers by changing the model string — openai/gpt-4o, anthropic/claude-sonnet, google/gemini — no SDK rewrites, one request schema.",
  },
  {
    icon: ShieldCheck,
    title: "Your keys, your data",
    body: "Self-hosted on your own Cloudflare account. Provider credentials are envelope-encrypted at rest; traffic never touches a third party.",
  },
  {
    icon: Gauge,
    title: "Rate limits & spend budgets",
    body: "Per-tenant and per-key requests-per-minute and tokens-per-minute buckets, spend caps that auto-disable keys when budgets are crossed.",
  },
  {
    icon: BarChart3,
    title: "Usage analytics",
    body: "Every request logged with tokens, latency, cache hits and estimated cost — filterable by key, provider and model.",
  },
  {
    icon: Users,
    title: "Team access control",
    body: "Owner, admin, member and viewer roles with email invitations, so teammates get exactly the access they need.",
  },
  {
    icon: KeyRound,
    title: "Key rotation & scoping",
    body: "Issue scoped proxy keys bound to providers or models, rotate upstream credentials without touching client integrations.",
  },
];

export function LandingPage() {
  const session = useSessionState();
  const repoUrl = useRepoUrl();
  const issuesUrl = `${repoUrl}/issues`;
  const primaryHref = session === "authed" ? "/dashboard" : "/signin";
  const primaryLabel =
    session === "authed" ? "Open dashboard" : "Get started — sign in";

  return (
    <div className="min-h-screen bg-white text-gray-900">
      {/* Top navigation */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
        <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Boxes size={20} className="text-indigo-600" />
            <span>Open LLM Proxy</span>
          </Link>
          <div className="flex items-center gap-2">
            {session === "loading" ? (
              <Spinner />
            ) : (
              <>
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hidden items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 sm:inline-flex"
                >
                  <Github size={14} /> GitHub
                </a>
                <Link
                  to={primaryHref}
                  className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700"
                >
                  {session === "authed" ? (
                    <>
                      Dashboard <ArrowRight size={13} />
                    </>
                  ) : (
                    "Sign in"
                  )}
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="border-b border-gray-100 bg-gradient-to-b from-indigo-50/70 to-white">
        <div className="mx-auto max-w-5xl px-4 py-20 text-center">
          <p className="mb-3 inline-block rounded-full border border-indigo-200 bg-white px-3 py-1 text-xs font-medium text-indigo-700">
            Open source · Runs entirely on Cloudflare Workers
          </p>
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            One OpenAI-compatible endpoint for{" "}
            <span className="text-indigo-600">every</span> LLM provider
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base text-gray-600 sm:text-lg">
            A self-hosted gateway that sits between your applications and
            OpenAI, Anthropic, Google Gemini, DeepSeek, Mistral and more. Bring
            your own keys — get rate limiting, budgets, analytics and team
            access out of the box.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              to={primaryHref}
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700"
            >
              {primaryLabel} <ArrowRight size={15} />
            </Link>
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <Star size={15} /> Star on GitHub
            </a>
          </div>

          {/* Example request */}
          <div className="mx-auto mt-12 max-w-2xl overflow-hidden rounded-lg border border-gray-200 bg-gray-950 text-left">
            <div className="border-b border-gray-800 px-4 py-2 font-mono text-[11px] text-gray-400">
              Works with any OpenAI SDK or HTTP client
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-gray-200">
              {`curl https://your-worker.workers.dev/v1/chat/completions \\
  -H "Authorization: Bearer <proxy-api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`}
            </pre>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-5xl px-4 py-16">
        <h2 className="text-center text-2xl font-semibold">
          Everything a production LLM gateway needs
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="rounded-lg border border-gray-200 bg-white p-5 transition hover:border-indigo-200 hover:shadow-sm"
            >
              <Icon size={20} className="text-indigo-600" />
              <h3 className="mt-3 text-sm font-semibold">{title}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-gray-600">
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Open source call-to-action */}
      <section className="border-y border-gray-100 bg-gray-50/70">
        <div className="mx-auto max-w-3xl px-4 py-14 text-center">
          <Github size={22} className="mx-auto text-gray-700" />
          <h2 className="mt-3 text-xl font-semibold">Free and open source</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-gray-600">
            Deploy it yourself in minutes, inspect every line, and shape its
            roadmap. If it saves you time, a star helps others find it — and bug
            reports make it better for everyone.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800"
            >
              <Star size={15} /> Visit the repository
            </a>
            <a
              href={issuesUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-100"
            >
              Report an issue
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-8 text-xs text-gray-500 sm:flex-row">
        <span>Open LLM Proxy · MIT licensed</span>
        <div className="flex items-center gap-4">
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-gray-700"
          >
            Repository
          </a>
          <a
            href={issuesUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-gray-700"
          >
            Issues
          </a>
          <Link to="/signin" className="hover:text-gray-700">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
