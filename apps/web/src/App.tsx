import { Navigate, Route, Routes } from "react-router-dom";

import { ImpersonationBanner } from "./components/auth/ImpersonationBanner";
import { AdminRoute, ProtectedRoute } from "./components/auth/ProtectedRoute";
import { AdminShell } from "./components/admin/AdminShell";
import { AppShell } from "./components/layout/AppShell";
import { AdminApiUsagePage } from "./pages/admin/ApiUsagePage";
import { AdminAuditPage } from "./pages/admin/AuditPage";
import { AdminBillingPage } from "./pages/admin/BillingPage";
import { AdminFeatureFlagsPage } from "./pages/admin/FeatureFlagsPage";
import { AdminInvitesPage } from "./pages/admin/InvitesPage";
import { AdminMetricsPage } from "./pages/admin/MetricsPage";
import { AdminPortfoliosPage } from "./pages/admin/PortfoliosPage";
import { AdminQueuePage } from "./pages/admin/QueuePage";
import { AdminTechAuditPage } from "./pages/admin/TechAuditPage";
import { AdminUsersPage } from "./pages/admin/UsersPage";
import { BillingPage } from "./pages/BillingPage";
import { ClosedPositionsPage } from "./pages/ClosedPositionsPage";
import { HomePage } from "./pages/HomePage";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { OpenPositionsPage } from "./pages/OpenPositionsPage";
import { OperationsPage } from "./pages/OperationsPage";
import {
  PasswordResetConfirmPage,
  PasswordResetRequestPage,
} from "./pages/PasswordResetPage";
import { PreferencesPage } from "./pages/PreferencesPage";
import { RegistryPage } from "./pages/RegistryPage";
import { ServerOpenPositionsPage } from "./pages/ServerOpenPositionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";
import { WalletDetailPage, WalletExplorePage } from "./pages/WalletDetailPage";
import { WalletsPage } from "./pages/WalletsPage";

function NotFound() {
  return (
    <div className="py-20 text-center text-muted-foreground">
      Page not found.
    </div>
  );
}

/**
 * F6b slice 5: pick the open-positions implementation based on
 * whether the legacy LoadedWalletsProvider has anything. SaaS users
 * with empty localStorage see the new server-driven page (sourced from
 * snapshot.positions). Power users with live client data keep the
 * full legacy view with V3 popups / lots / fees / per-position editing.
 */
function OpenPositionsRoute(): JSX.Element {
  return <ServerOpenPositionsPage />;
}

function AdminRoutes() {
  return (
    <AdminRoute>
      <AdminShell>
        <Routes>
          <Route index element={<Navigate to="metrics" replace />} />
          <Route path="metrics" element={<AdminMetricsPage />} />
          <Route path="portfolios" element={<AdminPortfoliosPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="invites" element={<AdminInvitesPage />} />
          <Route path="audit" element={<AdminAuditPage />} />
          <Route path="tech-audit" element={<AdminTechAuditPage />} />
          <Route path="queue" element={<AdminQueuePage />} />
          <Route path="api-usage" element={<AdminApiUsagePage />} />
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
          <Route path="/performance" element={<OpenPositionsRoute />} />
          <Route path="/closed" element={<ClosedPositionsPage />} />
          <Route path="/registry" element={<RegistryPage />} />
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
        <Route path="/invite/:token" element={<InvitePage />} />
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
