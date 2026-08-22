import { AuthLayout } from "./AuthLayout";
import { ResetPasswordForm } from "@contentgrowth/content-auth";
import { useNavigate, useSearchParams } from "react-router-dom";

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  return (
    <AuthLayout inCard={false}>
      <ResetPasswordForm
        token={token}
        onBackToLogin={() => navigate("/signin")}
        onSuccess={() => navigate("/signin")}
      />
    </AuthLayout>
  );
}
