/**
 * SVG donut chart с плавной анимацией заполнения сегментов и
 * интерактивным hover'ом: при наведении на сегмент — подсветка
 * (увеличенная толщина, лёгкий «лифт» наружу), остальные сегменты
 * затемняются.
 */

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface DonutSegment {
  key: string;
  /** Процент 0..100 (доля от total). */
  pct: number;
  /** Цвет сегмента (hex / hsl). */
  color: string;
}

interface AnimatedDonutProps {
  segments: DonutSegment[];
  /** Размер SVG в px. Default: 140. */
  size?: number;
  /** Толщина обводки. Default: 18. */
  stroke?: number;
  /** Длительность анимации в мс. Default: 700. */
  durationMs?: number;
  /** Подпись в центре donut'а. Динамическая если указан hovered key. */
  centerLabel?: { top?: string; main: string | number; bottom?: string };
  /** Hovered segment (управляется снаружи — DonutPanel). */
  hoveredKey?: string | null;
  onHover?: (key: string | null) => void;
  /** Показывать % внутри каждого сегмента (на кольце). Default: false. */
  showLabels?: boolean;
  /** Минимальная доля сегмента, при которой показываем лейбл. Default: 4. */
  minLabelPct?: number;
  className?: string;
}

export function AnimatedDonut({
  segments,
  size = 140,
  stroke = 18,
  durationMs = 700,
  centerLabel,
  hoveredKey,
  onHover,
  showLabels = false,
  minLabelPct = 4,
  className,
}: AnimatedDonutProps) {
  const radius = (size - stroke - 6) / 2; // 3px запас на лифт-анимацию
  const circumference = 2 * Math.PI * radius;

  // Анимируемая доля заполнения 0..1.
  const [progress, setProgress] = useState(0);
  const startRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setProgress(0);
    startRef.current = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startRef.current) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(segments.map((s) => `${s.key}:${s.pct}`))]);

  // Накопленные сегменты с применением progress.
  let cursor = 0;
  const arcs = segments.map((s) => {
    const fullLen = (s.pct / 100) * circumference;
    const animLen = fullLen * progress;
    const isHovered = hoveredKey === s.key;
    const isOther = hoveredKey != null && !isHovered;
    return {
      key: s.key,
      color: s.color,
      dash: `${animLen} ${circumference - animLen}`,
      offset: -cursor,
      isHovered,
      isOther,
    };
  });
  // cursor увеличиваем только после построения, чтобы все сегменты
  // получили правильный offset с учётом полной длины.
  cursor = 0;
  for (let i = 0; i < arcs.length; i++) {
    arcs[i]!.offset = -cursor;
    cursor += (segments[i]!.pct / 100) * circumference * progress;
  }

  return (
    <div
      className={cn("relative flex-shrink-0", className)}
      style={{ width: size, height: size }}
      onMouseLeave={() => onHover?.(null)}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={stroke}
          opacity={0.25}
        />
        {arcs.map((a) => (
          <circle
            key={a.key}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={a.color}
            strokeWidth={a.isHovered ? stroke + 4 : stroke}
            strokeDasharray={a.dash}
            strokeDashoffset={a.offset}
            strokeLinecap="butt"
            opacity={a.isOther ? 0.25 : 1}
            style={{
              transition: "stroke-width 180ms ease-out, opacity 180ms ease-out",
              cursor: onHover ? "pointer" : undefined,
            }}
            onMouseEnter={() => onHover?.(a.key)}
          />
        ))}
      </svg>
      {/* HTML-лейблы % — позиционируются вокруг кольца на середине каждого
          сегмента (огибают круг). Через HTML-оверлей, чтобы не воевать с
          SVG-rotation родителя. */}
      {showLabels &&
        progress > 0.95 &&
        (() => {
          let acc = 0;
          return segments.map((seg) => {
            const startPct = acc;
            acc += seg.pct;
            if (seg.pct < minLabelPct) return null;
            const midPct = startPct + seg.pct / 2;
            // 0% = top, идём по часовой → угол в HTML-координатах.
            const deg = (midPct / 100) * 360 - 90;
            const rad = (deg * Math.PI) / 180;
            const cx = size / 2 + radius * Math.cos(rad);
            const cy = size / 2 + radius * Math.sin(rad);
            const isOther = hoveredKey != null && hoveredKey !== seg.key;
            return (
              <span
                key={`lbl-${seg.key}`}
                className="pointer-events-none absolute select-none rounded-full bg-white px-1.5 py-0.5 text-[10px] font-bold leading-none text-slate-900 shadow-sm ring-1 ring-slate-200 transition-opacity duration-200 dark:bg-slate-900 dark:text-white dark:ring-slate-700"
                style={{
                  left: cx,
                  top: cy,
                  transform: "translate(-50%, -50%)",
                  opacity: isOther ? 0.35 : 1,
                }}
              >
                {seg.pct.toFixed(0)}%
              </span>
            );
          });
        })()}
      {centerLabel && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-3 text-center">
          {centerLabel.top && (
            <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {centerLabel.top}
            </span>
          )}
          <span className="text-sm font-bold tabular-nums leading-tight text-slate-900 dark:text-white">
            {centerLabel.main}
          </span>
          {centerLabel.bottom && (
            <span className="mt-0.5 text-[10px] font-medium text-slate-500 dark:text-slate-400">
              {centerLabel.bottom}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
