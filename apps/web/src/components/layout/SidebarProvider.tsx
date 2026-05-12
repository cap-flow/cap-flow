import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { useLocalStorage } from "@/lib/useLocalStorage";

interface SidebarContextValue {
  /** Свёрнут ли сайдбар на десктопе (управляется круглой кнопкой). */
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
  toggle: () => void;
  /** Открыт ли сайдбар на мобильном (drawer-режим). */
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsedRaw] = useLocalStorage<boolean>(
    "capflow.sidebar.collapsed",
    false,
  );
  // mobileOpen — runtime-only (не сохраняем в localStorage).
  const [mobileOpen, setMobileOpen] = useState(false);

  const setCollapsed = useCallback(
    (v: boolean) => setCollapsedRaw(v),
    [setCollapsedRaw],
  );
  const toggle = useCallback(
    () => setCollapsedRaw((p) => !p),
    [setCollapsedRaw],
  );

  const value = useMemo<SidebarContextValue>(
    () => ({ collapsed, setCollapsed, toggle, mobileOpen, setMobileOpen }),
    [collapsed, setCollapsed, toggle, mobileOpen],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside <SidebarProvider>");
  return ctx;
}
