import { AuthLayout } from "./AuthLayout";
import { authClient } from "@contentgrowth/content-auth";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const callbackURL = params.get("callbackURL") ?? "/dashboard";
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { error } = await authClient.verifyEmail({
          query: { token, callbackURL },
        });
        if (!alive) return;
        if (error) {
          setState("error");
          setMessage(error.message || "Verification failed");
        } else {
          setState("ok");
        }
      } catch (err) {
        if (alive) {
          setState("error");
          setMessage((err as Error).message || "Verification failed");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, callbackURL]);

  return (
    <AuthLayout>
      {state === "loading" && (
        <p className="text-center text-sm text-gray-500">
          Verifying your email…
        </p>
      )}
      {state === "ok" && (
        <div className="text-center">
          <p className="text-sm font-medium text-green-700">Email verified.</p>
          <p className="mt-1 text-sm text-gray-500">
            Your account is ready to use.
          </p>
          <Link
            to="/dashboard"
            className="mt-4 inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Go to console
          </Link>
        </div>
      )}
      {state === "error" && (
        <div className="text-center">
          <p className="text-sm font-medium text-red-600">
            Verification failed.
          </p>
          <p className="mt-1 text-xs text-gray-500">{message}</p>
          <Link
            to="/signin"
            className="mt-4 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-700"
          >
            Back to sign in
          </Link>
        </div>
      )}
    </AuthLayout>
  );
}
