/**
 * Анимация count-up для числовых значений. Плавно интерполирует от
 * предыдущего значения до нового через requestAnimationFrame.
 *
 * Принимает функцию форматирования, чтобы можно было использовать с
 * USD/percent/любым форматом локали.
 */

import { useEffect, useRef, useState } from "react";

interface AnimatedNumberProps {
  /** Целевое значение. */
  value: number;
  /** Форматирование (formatUsd / toFixed / etc). */
  format: (v: number) => string;
  /** Длительность анимации в мс. Default: 600. */
  durationMs?: number;
  /** className для span'а. */
  className?: string;
}

export function AnimatedNumber({
  value,
  format,
  durationMs = 600,
  className,
}: AnimatedNumberProps) {
  const [displayed, setDisplayed] = useState(value);
  const fromRef = useRef(value);
  const startRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // Если значение не изменилось — ничего не делаем.
    if (fromRef.current === value) {
      setDisplayed(value);
      return;
    }
    const from = fromRef.current;
    const to = value;
    startRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const t = Math.min(1, elapsed / durationMs);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (to - from) * eased;
      setDisplayed(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      fromRef.current = to;
    };
  }, [value, durationMs]);

  return <span className={className}>{format(displayed)}</span>;
}
