import { useNavigate } from "react-router-dom";
import { ForgotPasswordForm } from "@contentgrowth/content-auth";
import { AuthLayout } from "./AuthLayout";

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