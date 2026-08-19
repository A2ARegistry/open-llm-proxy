import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AuthForm } from "@contentgrowth/content-auth";
import { AuthLayout } from "./AuthLayout";
import { fetchBootstrapStatus } from "../../components/BootstrapGate";

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const invitationId = params.get("invitationId");
  const [hint, setHint] = useState<{ email: string; password: string } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    fetchBootstrapStatus()
      .then((s) => alive && setHint(s.defaultCredentials))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const afterAuth = () => {
    if (invitationId) {
      navigate(`/accept-invitation?id=${encodeURIComponent(invitationId)}`, { replace: true });
    } else {
      navigate("/dashboard", { replace: true });
    }
  };

  return (
    <AuthLayout>
      {hint && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">First-time setup credentials</p>
          <p className="mt-1 font-mono">
            {hint.email} / {hint.password}
          </p>
          <p className="mt-1 text-xs text-amber-700">
            You will be asked to change this password after signing in.
          </p>
        </div>
      )}
      <AuthForm
        view="signin"
        forgotPasswordUrl="/forgot-password"
        redirectUrl={invitationId ? `/accept-invitation?id=${encodeURIComponent(invitationId)}` : "/dashboard"}
        signupUrl="/signup"
        onSuccess={afterAuth}
      />
    </AuthLayout>
  );
}

export function SignUpPage() {
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <AuthForm
        view="signup"
        redirectUrl="/dashboard"
        signinUrl="/signin"
        onSuccess={() => navigate("/dashboard", { replace: true })}
      />
    </AuthLayout>
  );
}