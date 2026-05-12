/**
 * Сворачиваемая секция с плавной height-анимацией. Состояние сохраняется
 * в localStorage по `storageKey`, чтобы пользователь не сворачивал каждый
 * раз заново.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

interface CollapsibleSectionProps {
  /** Заголовок (рендерится в шапке слева). */
  title: React.ReactNode;
  /** Контент. */
  children: React.ReactNode;
  /** Доп. контент справа в шапке (счётчик, бейдж). */
  rightSlot?: React.ReactNode;
  /** Раскрыто по умолчанию. */
  defaultOpen?: boolean;
  /** Ключ для хранения состояния в localStorage. */
  storageKey?: string;
  /** Кастомный класс для контейнера. */
  className?: string;
  /**
   * Стиль шапки — кнопки сворачивания.
   * - `"brand"` — градиент cyan→blue (как primary CTA Button).
   *   Подходит когда секция важная и хочется сразу обратить внимание
   *   что её можно свернуть/раскрыть.
   * - `undefined` (default) — нейтральный фон.
   */
  headerVariant?: "brand";
}

export function CollapsibleSection({
  title,
  children,
  rightSlot,
  defaultOpen = true,
  storageKey,
  className,
  headerVariant,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(() => {
    if (!storageKey) return defaultOpen;
    if (typeof window === "undefined") return defaultOpen;
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "0") return false;
    if (saved === "1") return true;
    return defaultOpen;
  });

  useEffect(() => {
    if (!storageKey) return;
    window.localStorage.setItem(storageKey, open ? "1" : "0");
  }, [open, storageKey]);

  // Размонтируем контент когда закрыто — это даёт «свежий маунт»
  // дочерних компонентов при следующем раскрытии (нужно чтобы re-animate
  // AnimatedNumber и AnimatedDonut с нуля).
  // Слегка задерживаем unmount чтобы успела отыграть height-анимация.
  const [renderChildren, setRenderChildren] = useState(open);
  useEffect(() => {
    if (open) {
      setRenderChildren(true);
      return;
    }
    const t = window.setTimeout(() => setRenderChildren(false), 350);
    return () => window.clearTimeout(t);
  }, [open]);

  const isBrand = headerVariant === "brand";

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-4 py-2.5 text-left transition-all",
          isBrand
            ? // Брендовая шапка: градиент как у primary Button, ярко-цветной текст,
              // лёгкий glow при hover. Сразу понятно что это кликабельная кнопка.
              "bg-brand-gradient text-background font-semibold shadow-[0_4px_20px_-8px_rgba(34,211,238,0.5)] hover:brightness-110"
            : "hover:bg-secondary/40",
        )}
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform duration-200",
            isBrand ? "text-background" : "text-muted-foreground",
            !open && "-rotate-90",
          )}
        />
        <div className="flex-1">{title}</div>
        {rightSlot && <div className="ml-auto">{rightSlot}</div>}
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div
            className={cn(
              "transition-opacity duration-300",
              open ? "opacity-100" : "opacity-0",
            )}
          >
            {renderChildren ? children : null}
          </div>
        </div>
      </div>
    </section>
  );
}
