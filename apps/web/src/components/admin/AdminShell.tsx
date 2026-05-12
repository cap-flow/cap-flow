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
  ShieldAlert,
  ShieldCheck,
  Undo2,
  Users,
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
  return (
    <div className="relative min-h-screen app-glow">
      <AdminSidebar />
      <div className="lg:pl-64">
        <AdminTopbar />
        <main className="px-4 pb-12 pt-4 sm:px-6 lg:px-10">{children}</main>
      </div>
    </div>
  );
}

function AdminSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-card/95 backdrop-blur-md lg:flex">
      <div className="flex h-16 items-center gap-3 px-5">
        <LogoLockup />
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
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          <Undo2 className="h-4 w-4" />
          <span>В пользовательский режим</span>
        </NavLink>
      </div>
    </aside>
  );
}

function AdminTopbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-md sm:px-6 lg:px-10">
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
