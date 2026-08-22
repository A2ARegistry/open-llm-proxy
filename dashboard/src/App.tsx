import { AppShell } from "./components/AppShell";
import { BootstrapGate } from "./components/BootstrapGate";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { ApiKeysPage } from "./pages/ApiKeysPage";
import { DashboardPage } from "./pages/DashboardPage";
import { EmailPage } from "./pages/EmailPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TeamPage } from "./pages/TeamPage";
import { AcceptInvitationPage } from "./pages/auth/AcceptInvitationPage";
import { ForgotPasswordPage } from "./pages/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/auth/ResetPasswordPage";
import { SignInPage, SignUpPage } from "./pages/auth/SignInSignUp";
import { VerifyEmailPage } from "./pages/auth/VerifyEmailPage";
import { Routes, Route, Navigate } from "react-router-dom";

export default function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />

      <Route element={<ProtectedRoute />}>
        <Route
          element={
            <BootstrapGate>
              <AppShell />
            </BootstrapGate>
          }
        >
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/api-keys" element={<ApiKeysPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/email" element={<EmailPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
