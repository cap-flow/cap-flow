import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme, type Theme } from "./ThemeProvider";
import { cn } from "@/lib/utils";

/**
 * Компактный 3-режимный switcher темы для верхней панели:
 * Sun (light) · Moon (dark) · Monitor (system).
 * Активный режим подсвечивается, клик переключает мгновенно.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: "light", icon: Sun, label: "Светлая" },
    { value: "dark", icon: Moon, label: "Тёмная" },
    { value: "system", icon: Monitor, label: "Системная" },
  ];
  return (
    <div
      role="group"
      aria-label="Тема"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-secondary p-0.5"
    >
      {options.map((o) => {
        const Icon = o.icon;
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => setTheme(o.value)}
            aria-pressed={active}
            aria-label={o.label}
            title={o.label}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded transition-colors",
              active
                ? "bg-background text-brand-cyan shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}

/**
 * Полноценный селектор: Light / Dark / System — для страницы настроек.
 */
export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const options: { value: "light" | "dark" | "system"; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ];

  return (
    <div className="inline-flex rounded-md border border-border bg-secondary p-1">
      {options.map((o) => {
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => setTheme(o.value)}
            className={
              "rounded px-3 py-1.5 text-sm font-medium transition-colors " +
              (active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground")
            }
            aria-pressed={active}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
