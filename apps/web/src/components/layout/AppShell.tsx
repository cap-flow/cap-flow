import { NavLink } from "react-router-dom";
import {
  CreditCard,
  LayoutDashboard,
  LineChart,
  Menu,
  PieChart,
  Settings,
  Shield,
  Bell,
  BellRing,
  PanelLeftClose,
  PanelLeftOpen,
  Coins,
  Database,
  Receipt,
  ScrollText,
  Activity,
  FileText,
  Wallet as WalletIcon,
} from "lucide-react";

import { LogoLockup, LogoMark } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/profile/Avatar";
import { useProfile } from "@/components/profile/profile";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { useAuth } from "@/features/auth/AuthProvider";
import { useWalletsHydration } from "@/features/wallets/useWalletsHydration";
import { EmailVerificationBanner } from "@/components/auth/EmailVerificationBanner";
import { AccountSwitcher } from "./AccountSwitcher";
import { useSidebar } from "./SidebarProvider";
import { WalletSearch } from "./WalletSearch";
import { useT } from "@/i18n/I18nProvider";
import type { TranslationKey } from "@/i18n/locales/en";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  labelKey: TranslationKey;
  icon: typeof LayoutDashboard;
  end: boolean;
}

// Беспорядка нет: Реестр уже умеет подключить кошелёк и тянуть историю,
// «Кошельки» / «Операции» были дублями. Подписка и уведомления переехали
// внутрь «Настройки» (см. SettingsPage). Прямые маршруты /wallets /operations
// /billing /preferences остались живыми для invite-ссылок и закладок.
const NAV: NavItem[] = [
  { to: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, end: true },
  { to: "/performance", labelKey: "nav.performance", icon: LineChart, end: false },
  { to: "/insights", labelKey: "nav.insights", icon: PieChart, end: false },
  { to: "/registry", labelKey: "nav.registry", icon: Receipt, end: false },
  { to: "/assets", labelKey: "nav.assets", icon: Coins, end: false },
  { to: "/timeline", labelKey: "nav.timeline", icon: Activity, end: false },
  { to: "/tax", labelKey: "nav.tax", icon: FileText, end: false },
  { to: "/coverage", labelKey: "nav.coverage", icon: Database, end: false },
];

const SIDEBAR_W_OPEN = "w-64";
const SIDEBAR_W_CLOSED = "w-[72px]";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { collapsed, mobileOpen, setMobileOpen } = useSidebar();
  // Bridge: API wallets → legacy localStorage store the dashboard reads from.
  useWalletsHydration();
  return (
    <div className="relative min-h-screen app-glow">
      <Sidebar />
      {/* Затемнение позади mobile-drawer */}
      {mobileOpen && (
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="Закрыть меню"
          className="fixed inset-0 z-20 bg-background/60 backdrop-blur-sm lg:hidden"
        />
      )}
      <div
        className={cn(
          "transition-[padding] duration-200 ease-out",
          collapsed ? "lg:pl-[72px]" : "lg:pl-64",
        )}
      >
        <Topbar />
        <EmailVerificationBanner />
        <main className="px-4 pb-12 pt-4 sm:px-6 lg:px-10">{children}</main>
      </div>
    </div>
  );
}

function Sidebar() {
  const { collapsed, toggle, mobileOpen, setMobileOpen } = useSidebar();
  const t = useT();
  const { isAdmin } = useAuth();

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex flex-col border-r border-border bg-card/95 backdrop-blur-md",
        "transition-[width,transform] duration-200 ease-out",
        // Desktop: ширина управляется collapsed
        collapsed ? SIDEBAR_W_CLOSED : SIDEBAR_W_OPEN,
        // Mobile (<lg): drawer-режим. Скрыт по умолчанию, открывается через mobileOpen.
        "lg:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
      )}
    >
      <div className={cn("flex h-16 items-center", collapsed ? "justify-center px-2" : "px-5")}>
        {collapsed ? <LogoMark size={28} /> : <LogoLockup />}
      </div>

      <nav className={cn("flex-1 space-y-1", collapsed ? "px-2" : "px-3 py-2")}>
        {NAV.map(({ to, labelKey, icon: Icon, end }) => {
          const label = t(labelKey);
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMobileOpen(false)}
              title={collapsed ? label : undefined}
              className={({ isActive }) =>
                cn(
                  "flex items-center rounded-md text-sm font-medium transition-colors",
                  collapsed ? "h-10 w-full justify-center" : "gap-3 px-3 py-2",
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isActive ? "text-brand-cyan" : "text-muted-foreground",
                    )}
                  />
                  {!collapsed && <span>{label}</span>}
                </>
              )}
            </NavLink>
          );
        })}

        {isAdmin && (
          <NavLink
            to="/admin"
            onClick={() => setMobileOpen(false)}
            title={collapsed ? "Admin" : undefined}
            className={({ isActive }) =>
              cn(
                "flex items-center rounded-md text-sm font-medium transition-colors",
                collapsed ? "h-10 w-full justify-center" : "gap-3 px-3 py-2",
                "mt-2 border-t border-border/60 pt-3",
                isActive
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            <Shield className="h-4 w-4 shrink-0 text-brand-cyan" />
            {!collapsed && <span>Admin</span>}
          </NavLink>
        )}
      </nav>

      {!collapsed && (
        <div className="px-3 pb-4">
          <div className="rounded-lg border border-border bg-gradient-to-br from-brand-mint/10 via-brand-cyan/10 to-brand-blue/15 p-4">
            <p className="text-xs font-semibold text-foreground">
              {t("sidebar.pro.title")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("sidebar.pro.subtitle")}
            </p>
            <Button size="sm" className="mt-3 w-full">
              {t("sidebar.pro.cta")}
            </Button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={toggle}
        aria-label={
          collapsed ? t("topbar.sidebar.expand") : t("topbar.sidebar.collapse")
        }
        title={collapsed ? t("topbar.sidebar.expand") : t("topbar.sidebar.collapse")}
        className={cn(
          "absolute top-7 -right-3 z-40 hidden lg:flex",
          "h-6 w-6 items-center justify-center rounded-full",
          "border border-border bg-card text-muted-foreground shadow-sm",
          "hover:text-foreground hover:bg-accent transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        {collapsed ? (
          <PanelLeftOpen className="h-3.5 w-3.5" />
        ) : (
          <PanelLeftClose className="h-3.5 w-3.5" />
        )}
      </button>
    </aside>
  );
}

function Topbar() {
  const { setMobileOpen } = useSidebar();
  const [profile] = useProfile();
  const t = useT();

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-md sm:px-6 lg:px-10">
      {/* Mobile-only: бургер для drawer'а сайдбара. На десктопе сайдбар
          фиксирован, и для сворачивания у него своя круглая кнопка справа. */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setMobileOpen(true)}
        aria-label="Открыть меню"
        className="lg:hidden"
      >
        <Menu />
      </Button>
      <div className="lg:hidden">
        <LogoLockup />
      </div>

      <div className="ml-auto flex flex-1 items-center justify-end gap-2 sm:gap-3">
        <WalletSearch />

        <AccountSwitcher />

        <ThemeToggle />

        <Button variant="ghost" size="icon" aria-label={t("topbar.notifications")}>
          <Bell />
        </Button>

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              "inline-flex h-10 w-10 items-center justify-center rounded-md transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )
          }
          aria-label={t("nav.settings")}
          title={t("nav.settings")}
        >
          <Settings className="h-4 w-4" />
        </NavLink>

        <NavLink
          to="/settings"
          className="flex items-center gap-2 rounded-full border border-border bg-secondary pl-1 pr-3 py-1 hover:bg-accent transition-colors"
          aria-label={t("settings.section.profile")}
          title={t("settings.section.profile")}
        >
          <Avatar profile={profile} size={28} />
          <span className="text-sm font-medium">
            {profile.displayName || profile.username}
          </span>
        </NavLink>
      </div>
    </header>
  );
}
