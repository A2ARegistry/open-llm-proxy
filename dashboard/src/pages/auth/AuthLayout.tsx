import { ReactNode } from "react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 text-lg font-bold text-white">
            LP
          </div>
          <span className="text-lg font-semibold text-gray-900">Open LLM Proxy</span>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          {children}
        </div>
        <p className="mt-4 text-center text-xs text-gray-400">
          OpenAI-compatible LLM gateway with per-tenant spend controls.
        </p>
      </div>
    </div>
  );
}