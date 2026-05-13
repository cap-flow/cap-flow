import { useState } from "react";
import {
  ActivityIcon,
  BarChart3,
  CreditCard,
  DollarSign,
  Flag,
  LayoutGrid,
  ListChecks,
  LogOut,
  MailPlus,
  Menu,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";

import { LogoLockup } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";
import { cn } from "@/lib/utils";

interface AdminNavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof Users;
}

const ADMIN_NAV: AdminNavItem[] = [
  { to: "/admin/metrics", label: "SaaS-метрики", icon: BarChart3 },
  { to: "/admin/portfolios", label: "Портфели", icon: LayoutGrid },
  { to: "/admin/users", label: "Пользователи", icon: Users },
  { to: "/admin/invites", label: "Приглашения", icon: MailPlus },
  { to: "/admin/billing", label: "Биллинг", icon: CreditCard },
  { to: "/admin/feature-flags", label: "Feature flags", icon: Flag },
  { to: "/admin/audit", label: "Аудит-лог", icon: ListChecks },
  { to: "/admin/tech-audit", label: "Тех. аудит", icon: ShieldAlert },
  { to: "/admin/queue", label: "Очередь", icon: ActivityIcon },
  { to: "/admin/api-usage", label: "Расходы API", icon: DollarSign },
];

export function AdminShell({ children }: { readonly children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="relative min-h-screen app-glow">
      <AdminSidebar
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      {/* Backdrop — visible only when mobile menu is open. Tap-to-close. */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Закрыть меню"
          className="fixed inset-0 z-20 bg-background/80 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div className="lg:pl-64">
        <AdminTopbar onMenuClick={() => setMobileOpen(true)} />
        <main className="px-4 pb-12 pt-4 sm:px-6 lg:px-10">{children}</main>
      </div>
    </div>
  );
}

function AdminSidebar({
  mobileOpen,
  onClose,
}: {
  readonly mobileOpen: boolean;
  readonly onClose: () => void;
}) {
  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-border bg-card/95 backdrop-blur-md transition-transform duration-200",
        // <lg: slide in/out based on mobileOpen.  lg+: always visible.
        mobileOpen ? "translate-x-0" : "-translate-x-full",
        "lg:translate-x-0"
      )}
    >
      <div className="flex h-16 items-center gap-3 px-5">
        <LogoLockup />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Закрыть меню"
          onClick={onClose}
          className="ml-auto lg:hidden"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>
      <div className="px-5 pb-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-cyan/40 bg-brand-cyan/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-brand-cyan">
          <ShieldCheck className="h-3.5 w-3.5" />
          Admin
        </span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {ADMIN_NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onClose}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    isActive ? "text-brand-cyan" : "text-muted-foreground"
                  )}
                />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 pb-4">
        <NavLink
          to="/"
          onClick={onClose}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <Undo2 className="h-4 w-4" />
          <span>В пользовательский режим</span>
        </NavLink>
      </div>
    </aside>
  );
}

function AdminTopbar({ onMenuClick }: { readonly onMenuClick: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-md sm:px-6 lg:px-10">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Открыть меню"
        onClick={onMenuClick}
        className="lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-sm text-muted-foreground sm:inline">
          {user?.name} · {user?.email}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLogout}
          className="gap-2"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">Выйти</span>
        </Button>
      </div>
    </header>
  );
}
