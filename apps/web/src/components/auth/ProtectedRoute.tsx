import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { useAuth } from "@/features/auth/AuthProvider";

/**
 * Gates a subtree behind a logged-in session. While the auth provider is
 * still booting (probing the refresh cookie), shows a placeholder so we
 * don't flash the login screen for already-authenticated users.
 */
export function ProtectedRoute({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const { user } = useAuth();
  const location = useLocation();

  if (user === undefined) {
    return <BootSplash />;
  }
  if (user === null) {
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    );
  }
  return <>{children}</>;
}

/**
 * Stricter variant: must be logged in AND have `role === "admin"`. Non-admins
 * land on `/` (their own dashboard); the admin nav is hidden from them
 * separately so this is defence-in-depth, not the primary gate.
 */
export function AdminRoute({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const { user, isAdmin } = useAuth();
  const location = useLocation();

  if (user === undefined) return <BootSplash />;
  if (user === null) {
    return (
      <Navigate to="/login" replace state={{ from: location.pathname }} />
    );
  }
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function BootSplash(): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted-foreground">
      <span className="text-sm">Загрузка…</span>
    </div>
  );
}
