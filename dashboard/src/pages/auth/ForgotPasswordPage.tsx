import { AuthLayout } from "./AuthLayout";
import { ForgotPasswordForm } from "@contentgrowth/content-auth";
import { useNavigate } from "react-router-dom";

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  return (
    <AuthLayout inCard={false}>
      <ForgotPasswordForm
        onBackToLogin={() => navigate("/signin")}
        onSuccess={() => navigate("/signin")}
      />
    </AuthLayout>
  );
}
