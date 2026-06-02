import { Navigate, Route, Routes } from "react-router-dom";

import { ImpersonationBanner } from "./components/auth/ImpersonationBanner";
import { AdminRoute, ProtectedRoute } from "./components/auth/ProtectedRoute";
import { AdminShell } from "./components/admin/AdminShell";
import { AppShell } from "./components/layout/AppShell";
import { AdminApiUsagePage } from "./pages/admin/ApiUsagePage";
import { AdminAuditPage } from "./pages/admin/AuditPage";
import { AdminBillingPage } from "./pages/admin/BillingPage";
import { AdminFeatureFlagsPage } from "./pages/admin/FeatureFlagsPage";
import { AdminIntegrationsPage } from "./pages/admin/IntegrationsPage";
import { AdminInvitesPage } from "./pages/admin/InvitesPage";
import { AdminMetricsPage } from "./pages/admin/MetricsPage";
import { AdminPortfoliosPage } from "./pages/admin/PortfoliosPage";
import { AdminOperationsRegistryPage } from "./pages/admin/OperationsRegistryPage";
import { AdminQueuePage } from "./pages/admin/QueuePage";
import { AdminHealthPage } from "./pages/admin/HealthPage";
import { AdminTechAuditPage } from "./pages/admin/TechAuditPage";
import { AdminUcbServerPage } from "./pages/admin/UcbServerPage";
import { AdminAnomaliesPage } from "./pages/admin/AnomaliesPage";
import { AdminUsersPage } from "./pages/admin/UsersPage";
import { AdminUserDetailPage } from "./pages/admin/UserDetailPage";
import { AdminTelegramChatPage } from "./pages/admin/TelegramChatPage";
import { BillingPage } from "./pages/BillingPage";
import { ClosedPositionsPage } from "./pages/ClosedPositionsPage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { SetPasswordPage } from "./pages/SetPasswordPage";
import { OpenPositionsPage } from "./pages/OpenPositionsPage";
import { OperationsPage } from "./pages/OperationsPage";
import {
  PasswordResetConfirmPage,
  PasswordResetRequestPage,
} from "./pages/PasswordResetPage";
import { PreferencesPage } from "./pages/PreferencesPage";
import { RegistryPage } from "./pages/RegistryPage";
import { CoveragePage } from "./pages/CoveragePage";
import { AssetsPage } from "./pages/AssetsPage";
import { PositionDetailPage } from "./pages/PositionDetailPage";
import { TimelinePage } from "./pages/TimelinePage";
import { TaxPage } from "./pages/TaxPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { WalletDetailPage, WalletExplorePage } from "./pages/WalletDetailPage";
import { WalletsPage } from "./pages/WalletsPage";

function NotFound() {
  return (
    <div className="py-20 text-center text-muted-foreground">
      Page not found.
    </div>
  );
}

function AdminRoutes() {
  return (
    <AdminRoute>
      <AdminShell>
        <Routes>
          <Route index element={<Navigate to="metrics" replace />} />
          <Route path="metrics" element={<AdminMetricsPage />} />
          <Route path="portfolios" element={<AdminPortfoliosPage />} />
          <Route path="operations" element={<AdminOperationsRegistryPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="users/:id" element={<AdminUserDetailPage />} />
          <Route path="invites" element={<AdminInvitesPage />} />
          <Route path="audit" element={<AdminAuditPage />} />
          <Route path="tech-audit" element={<AdminTechAuditPage />} />
          <Route path="ucb-server" element={<AdminUcbServerPage />} />
          <Route path="anomalies" element={<AdminAnomaliesPage />} />
          <Route path="queue" element={<AdminQueuePage />} />
          <Route path="health" element={<AdminHealthPage />} />
          <Route path="api-usage" element={<AdminApiUsagePage />} />
          <Route path="integrations" element={<AdminIntegrationsPage />} />
          <Route path="telegram-chat" element={<AdminTelegramChatPage />} />
          <Route path="billing" element={<AdminBillingPage />} />
          <Route path="feature-flags" element={<AdminFeatureFlagsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AdminShell>
    </AdminRoute>
  );
}

function UserRoutes() {
  return (
    <ProtectedRoute>
      <AppShell>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/performance" element={<OpenPositionsPage />} />
          <Route path="/positions/:positionId" element={<PositionDetailPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/tax" element={<TaxPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/closed" element={<ClosedPositionsPage />} />
          <Route path="/registry" element={<RegistryPage />} />
          <Route path="/coverage" element={<CoveragePage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/wallet/explore" element={<WalletExplorePage />} />
          <Route path="/wallet/:walletId" element={<WalletDetailPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/wallets" element={<WalletsPage />} />
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/preferences" element={<PreferencesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AppShell>
    </ProtectedRoute>
  );
}

export function App(): JSX.Element {
  return (
    <>
      <ImpersonationBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Set-password — для Telegram-signup юзеров после finish-redirect'a.
            Не оборачиваем в ProtectedRoute: страница сама редиректит на /
            если у юзера уже есть пароль; cookie выдаётся /finish'ем. */}
        <Route path="/auth/set-password" element={<SetPasswordPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
        <Route path="/reset-password" element={<PasswordResetRequestPage />} />
        <Route
          path="/reset-password/:token"
          element={<PasswordResetConfirmPage />}
        />
        <Route path="/admin/*" element={<AdminRoutes />} />
        <Route path="/*" element={<UserRoutes />} />
      </Routes>
    </>
  );
}
