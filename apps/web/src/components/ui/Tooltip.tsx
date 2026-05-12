/**
 * Кастомный tooltip с мгновенным показом на hover. Native `title=` слишком
 * медленный (~500ms задержка) и нестилизуемый.
 *
 * Использование:
 *   <Tooltip content="описание метрики">
 *     <InfoIcon />
 *   </Tooltip>
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  /** Где показать относительно триггера. Default: "top". */
  side?: "top" | "bottom" | "left" | "right";
  /** Макс. ширина tooltip в px. Default: 280. */
  maxWidth?: number;
  /** Вкл/выкл — удобно для условного рендера. */
  disabled?: boolean;
}

export function Tooltip({
  content,
  children,
  side = "top",
  maxWidth = 280,
  disabled,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function place() {
      const t = triggerRef.current?.getBoundingClientRect();
      const tip = tipRef.current?.getBoundingClientRect();
      if (!t || !tip) return;
      const margin = 8;
      let top = 0;
      let left = 0;
      switch (side) {
        case "top":
          top = t.top - tip.height - margin;
          left = t.left + (t.width - tip.width) / 2;
          break;
        case "bottom":
          top = t.bottom + margin;
          left = t.left + (t.width - tip.width) / 2;
          break;
        case "left":
          top = t.top + (t.height - tip.height) / 2;
          left = t.left - tip.width - margin;
          break;
        case "right":
          top = t.top + (t.height - tip.height) / 2;
          left = t.right + margin;
          break;
      }
      // Ограничиваем viewport'ом
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      left = Math.max(margin, Math.min(left, vw - tip.width - margin));
      top = Math.max(margin, Math.min(top, vh - tip.height - margin));
      setPos({ top, left });
    }
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, side]);

  if (disabled) return <>{children}</>;

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex"
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className={cn(
              "pointer-events-none fixed z-[1000] rounded-md border border-border bg-popover px-3 py-2 text-xs text-foreground shadow-lg",
              "animate-in fade-in-0 zoom-in-95",
            )}
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              maxWidth,
              opacity: pos ? 1 : 0,
              transition: "opacity 0.12s",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
