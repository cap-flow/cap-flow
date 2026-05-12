/**
 * Унифицированный «pill» для фильтров (использовался в OpenPositionsPage,
 * теперь общий — нужен и в Registry).
 */

import { cn } from "@/lib/utils";
import type { WalletChain } from "@/lib/wallets";

export function Chip({
  active,
  onClick,
  label,
  count,
  chain,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  chain?: WalletChain;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        active
          ? "border-brand-cyan/60 bg-brand-cyan/15 text-brand-cyan"
          : "border-border bg-secondary text-muted-foreground hover:text-foreground",
      )}
    >
      {chain && (
        <span
          className={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            chain === "sol"
              ? "bg-[#14F195]"
              : chain === "coinstats"
                ? "bg-purple-400"
                : "bg-brand-cyan",
          )}
        />
      )}
      {label}
      {count != null && (
        <span className="text-[10px] opacity-70">({count})</span>
      )}
    </button>
  );
}
