import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authClient } from "@contentgrowth/content-auth";
import { AuthLayout } from "./AuthLayout";

export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const invitationId = params.get("id") ?? "";
  const [state, setState] = useState<"loading" | "need-auth" | "ok" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: session } = await authClient.getSession();
        if (!alive) return;
        if (!session) {
          setState("need-auth");
          return;
        }
        const { error } = await authClient.organization.acceptInvitation({
          invitationId,
        });
        if (!alive) return;
        if (error) {
          setState("error");
          setMessage(error.message || "Could not accept invitation");
        } else {
          setState("ok");
        }
      } catch (err) {
        if (alive) {
          setState("error");
          setMessage((err as Error).message || "Could not accept invitation");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [invitationId]);

  return (
    <AuthLayout>
      {state === "loading" && <p className="text-center text-sm text-gray-500">Accepting invitation…</p>}
      {state === "need-auth" && (
        <div className="text-center">
          <p className="text-sm text-gray-600">
            Sign in to join the organization and accept this invitation.
          </p>
          <Link
            to={`/signin?invitationId=${encodeURIComponent(invitationId)}`}
            className="mt-4 inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Sign in
          </Link>
        </div>
      )}
      {state === "ok" && (
        <div className="text-center">
          <p className="text-sm font-medium text-green-700">You’re in.</p>
          <p className="mt-1 text-sm text-gray-500">
            The organization has been added to your account.
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
          <p className="text-sm font-medium text-red-600">Invitation failed.</p>
          <p className="mt-1 text-xs text-gray-500">{message}</p>
        </div>
      )}
    </AuthLayout>
  );
}