import { ReactNode } from "react";

export function AuthLayout({
  children,
  inCard = true,
}: {
  children: ReactNode;
  inCard?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-50 via-slate-50 to-slate-100 px-4 py-12">
      <div className="pointer-events-none absolute -top-32 -left-32 h-96 w-96 rounded-full bg-indigo-200/40 blur-3xl" />
      <div className="pointer-events-none absolute -right-32 -bottom-32 h-96 w-96 rounded-full bg-sky-200/40 blur-3xl" />

      <div className="relative w-full max-w-md">
        {/* Logo and branding */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-indigo-700 shadow-lg shadow-indigo-600/25">
            <svg
              className="h-8 w-8 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Open LLM Proxy
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Enterprise-grade LLM gateway
          </p>
        </div>

        {inCard ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/50">
            {children}
          </div>
        ) : (
          <div>{children}</div>
        )}

        {/* Footer */}
        <div className="mt-8 text-center">
          <p className="text-xs text-slate-500">
            OpenAI-compatible gateway with multi-tenant isolation
          </p>
          <div className="mt-4 flex items-center justify-center gap-6 text-xs text-slate-400">
            <a href="#" className="transition-colors hover:text-indigo-600">
              Documentation
            </a>
            <span>•</span>
            <a href="#" className="transition-colors hover:text-indigo-600">
              Support
            </a>
            <span>•</span>
            <a href="#" className="transition-colors hover:text-indigo-600">
              Status
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
