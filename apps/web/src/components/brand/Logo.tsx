import { useT } from "@/i18n/I18nProvider";
import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * Знак Capflow: стилизованная "C" с тремя горизонтальными "потоками".
 * Цвета — фирменный градиент mint → cyan → blue.
 */
export function LogoMark({ className, size = 36 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id="cf-c" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34E0B6" />
          <stop offset="55%" stopColor="#22D3EE" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
        <linearGradient id="cf-l" x1="0" y1="0" x2="64" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34E0B6" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>

      {/* "C" — открытое кольцо */}
      <path
        d="M52 16a22 22 0 1 0 0 32"
        stroke="url(#cf-c)"
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
      />

      {/* Три "потока капитала" */}
      <path d="M14 26h26" stroke="url(#cf-l)" strokeWidth="3" strokeLinecap="round" opacity=".95" />
      <path d="M10 32h32" stroke="url(#cf-l)" strokeWidth="3" strokeLinecap="round" opacity=".75" />
      <path d="M14 38h26" stroke="url(#cf-l)" strokeWidth="3" strokeLinecap="round" opacity=".55" />
    </svg>
  );
}

export function LogoLockup({ className }: { className?: string }) {
  const t = useT();
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <LogoMark size={32} />
      <div className="flex flex-col leading-none">
        <span className="text-xl font-semibold tracking-tight">
          <span className="text-foreground">Cap</span>
          <span className="text-brand-gradient">flow</span>
        </span>
        <span className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {t("brand.tagline")}
        </span>
      </div>
    </div>
  );
}
