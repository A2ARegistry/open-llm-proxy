import { Link, useNavigate } from "react-router-dom";
import { ForgotPasswordForm } from "@contentgrowth/content-auth";
import { AuthLayout } from "./AuthLayout";

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <ForgotPasswordForm
        onBackToLogin={() => navigate("/signin")}
        onSuccess={() => navigate("/signin")}
      />
      <p className="mt-4 text-center text-sm text-gray-500">
        <Link to="/signin" className="text-indigo-600 hover:text-indigo-700">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}