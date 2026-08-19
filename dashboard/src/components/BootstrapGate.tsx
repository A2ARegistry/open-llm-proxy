import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiSend } from "../lib/api";
import { Spinner } from "./ui";

interface BootstrapStatus {
  initialized: boolean;
  defaultCredentials: { email: string; password: string } | null;
}

/**
 * Full-screen gate shown to the freshly-seeded admin until they rotate the
 * default `AwesomeProxy!!` password. Also shown as the login hint on /signin.
 */
export async function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  const res = await fetch("/api/bootstrap/status", { credentials: "include" });
  const body = await res.json().catch(() => ({}));
  return {
    initialized: Boolean(body.initialized),
    defaultCredentials: body.defaultCredentials ?? null,
  };
}

export function BootstrapGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [mustChange, setMustChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchBootstrapStatus()
      .then((s) => alive && setMustChange(Boolean(s.defaultCredentials)))
      .catch(() => alive && setMustChange(false))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner label="Checking setup…" />
      </div>
    );
  }

  if (!mustChange) {
    return <>{children}</>;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters");
      return;
    }
    if (newPassword !== confirm) {
      setError("New password and confirmation do not match");
      return;
    }
    setBusy(true);
    try {
      await apiSend("POST", "/api/bootstrap/change-password", {
        currentPassword,
        newPassword,
      });
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError((err as { message?: string }).message || "Password change failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-xl font-bold text-white">
            LP
          </div>
          <h1 className="text-xl font-semibold text-gray-900">
            Set a new admin password
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            You signed in with the default credentials. Choose a strong
            password to continue.
          </p>
        </div>
        <form
          onSubmit={submit}
          className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
        >
          {error && (
            <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Current password
          </label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            className="mb-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <label className="mb-1 block text-sm font-medium text-gray-700">
            New password
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={12}
            className="mb-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Confirm new password
          </label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            minLength={12}
            className="mb-6 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Change password"}
          </button>
        </form>
      </div>
    </div>
  );
}
