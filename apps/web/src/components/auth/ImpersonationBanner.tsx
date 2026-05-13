import { AlertTriangle, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";

/**
 * Persistent red banner shown across the app whenever the current session
 * is an admin impersonation. Renders nothing if `user.impersonation` is
 * absent — safe to mount unconditionally.
 */
export function ImpersonationBanner(): JSX.Element | null {
  const { user, isImpersonating, impersonationOrigin, endImpersonation } =
    useAuth();
  const navigate = useNavigate();

  if (!user || !isImpersonating) return null;

  async function handleEnd() {
    await endImpersonation();
    // After endImpersonation the AuthProvider has swapped tokens back
    // to the admin session and refetched /me. Send the admin straight
    // back to the place they came from (the portfolios drill-in list).
    // If the backend couldn't restore the admin (rare — admin row
    // deleted or role demoted) AuthProvider fell back to logout, and
    // ProtectedRoute will intercept the next render to push /login.
    navigate("/admin/portfolios", { replace: true });
  }

  const originLabel = impersonationOrigin
    ? `${impersonationOrigin.admin.email}`
    : "admin";

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex items-center gap-3 border-b border-red-500/40 bg-red-500/15 px-4 py-2 text-sm backdrop-blur-md sm:px-6"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
      <div className="flex-1 leading-snug">
        <span className="font-medium text-red-200">
          Вы вошли как {user.name} ({user.email})
        </span>
        <span className="text-red-300/80"> · view-mode от {originLabel}</span>
      </div>
      <Button
        variant="destructive"
        size="sm"
        onClick={handleEnd}
        className="gap-2"
      >
        <LogOut className="h-4 w-4" />
        Завершить
      </Button>
    </div>
  );
}
