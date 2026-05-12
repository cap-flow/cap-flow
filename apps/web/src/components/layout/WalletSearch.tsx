/**
 * Поиск по сохранённым кошелькам — по имени, адресу, сети.
 *
 * Live-фильтрация. Кликом по результату открываем `/wallet/:walletId`
 * в **новой вкладке**, чтобы пользователь мог изучать конкретный кошелёк
 * параллельно с дашбордом.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Search, Telescope, Wallet as WalletIcon } from "lucide-react";

import { useT } from "@/i18n/I18nProvider";
import { useWallets, type SavedWallet } from "@/lib/wallets";
import { detectAddressChain } from "@/pages/WalletDetailPage";
import { cn } from "@/lib/utils";

const CHAIN_LABEL: Record<string, string> = {
  evm: "EVM",
  sol: "Solana",
  coinstats: "CoinStats",
};

function shortAddress(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

/**
 * Нормализуем строку для сравнения: lowercase, убираем все пробелы
 * (включая невидимые ​-‏ и ﻿, которые часто прилипают
 * при копипасте) и опциональный префикс `0x`.
 */
function normForMatch(s: string): string {
  return s
    .replace(/[\s​-‏﻿]+/g, "")
    .toLowerCase()
    .replace(/^0x/, "");
}

export function WalletSearch() {
  const t = useT();
  const { list } = useWallets();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+K — фокус в поиск.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Закрыть dropdown при клике вне.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  type Item =
    | { kind: "saved"; wallet: SavedWallet }
    | { kind: "explore"; address: string; chain: "evm" | "sol" };

  const items = useMemo<Item[]>(() => {
    const raw = query.trim();
    if (!raw) return list.slice(0, 8).map((w) => ({ kind: "saved", wallet: w }));
    const qLower = raw.toLowerCase();
    const qNorm = normForMatch(raw);
    const saved: Item[] = list
      .filter((w) => {
        const addrNorm = normForMatch(w.address);
        return (
          w.name.toLowerCase().includes(qLower) ||
          addrNorm.includes(qNorm) ||
          w.address.toLowerCase().includes(qLower) ||
          w.chain.toLowerCase().includes(qLower) ||
          (w.connectionId ?? "").toLowerCase().includes(qLower)
        );
      })
      .slice(0, 8)
      .map((w) => ({ kind: "saved", wallet: w }));

    // Если запрос — валидный адрес, добавляем «Изучить» в самый верх,
    // чтобы пользователь мог одним кликом посмотреть произвольный кошелёк.
    const chain = detectAddressChain(raw);
    if (chain) {
      // Не показываем explore если этот же адрес уже среди сохранённых.
      const alreadySaved = saved.some(
        (it) =>
          it.kind === "saved" &&
          normForMatch(it.wallet.address) === normForMatch(raw),
      );
      if (!alreadySaved) {
        return [{ kind: "explore", address: raw, chain }, ...saved];
      }
    }
    return saved;
  }, [list, query]);

  // Сбрасываем активный индекс при смене результатов.
  useEffect(() => {
    setActiveIdx(0);
  }, [items.length, query]);

  function openWallet(walletId: string) {
    // Новая вкладка — пользователь хочет изучать кошелёк отдельно.
    window.open(`/wallet/${walletId}`, "_blank", "noopener,noreferrer");
  }

  function openExplore(chain: "evm" | "sol", address: string) {
    const url = `/wallet/explore?chain=${chain}&address=${encodeURIComponent(address)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function activate(item: Item) {
    if (item.kind === "saved") openWallet(item.wallet.id);
    else openExplore(item.chain, item.address);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      const it = items[activeIdx];
      if (it) activate(it);
    }
  }

  return (
    <div ref={containerRef} className="relative hidden md:block">
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 w-72 text-sm text-muted-foreground transition-colors",
          open && "border-brand-cyan/50",
        )}
      >
        <Search className="h-4 w-4" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t("topbar.search")}
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70 text-foreground"
        />
        <kbd className="hidden rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground md:inline">
          ⌘K
        </kbd>
      </div>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[min(420px,80vw)] overflow-hidden rounded-md border border-border bg-card shadow-xl">
          {items.length === 0 ? (
            <div className="space-y-1 px-3 py-4 text-center text-xs text-muted-foreground">
              {query.trim() ? (
                <>
                  <div>Не похоже на адрес кошелька.</div>
                  <div className="text-[10px]">
                    Вставьте EVM (0x… 40 hex) или Solana (base58, 32–44 симв.)
                    адрес — откроется аналитика по нему.
                  </div>
                  <div className="text-[10px]">
                    Сохранённых: {list.length}
                  </div>
                </>
              ) : (
                "Введите имя или вставьте адрес"
              )}
            </div>
          ) : (
            <>
              <div className="border-b border-border/50 bg-secondary/30 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {query.trim()
                  ? `Найдено: ${items.length}`
                  : "Сохранённые кошельки"}
              </div>
              <ul className="max-h-[60vh] overflow-y-auto py-1">
                {items.map((it, i) => (
                  <li key={it.kind === "saved" ? it.wallet.id : `explore-${it.address}`}>
                    {it.kind === "explore" ? (
                      <button
                        type="button"
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => activate(it)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                          i === activeIdx
                            ? "bg-brand-cyan/15 text-foreground"
                            : "text-foreground/90 hover:bg-brand-cyan/10",
                        )}
                      >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-brand-mint to-brand-cyan text-slate-900">
                          <Telescope className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">
                              Изучить адрес
                            </span>
                            <span className="rounded border border-brand-cyan/40 bg-brand-cyan/10 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-brand-cyan">
                              {CHAIN_LABEL[it.chain]}
                            </span>
                          </div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {shortAddress(it.address)}
                          </div>
                        </div>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-brand-cyan" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => activate(it)}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                          i === activeIdx
                            ? "bg-accent/60 text-foreground"
                            : "text-foreground/90 hover:bg-accent/40",
                        )}
                      >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-brand-cyan/30 bg-brand-cyan/10 text-brand-cyan">
                          <WalletIcon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">
                              {it.wallet.name}
                            </span>
                            <span className="rounded border border-border bg-secondary/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                              {CHAIN_LABEL[it.wallet.chain] ?? it.wallet.chain}
                            </span>
                            {it.wallet.connectionId && (
                              <span className="rounded border border-border bg-secondary/60 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                                {it.wallet.connectionId}
                              </span>
                            )}
                          </div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {shortAddress(it.wallet.address)}
                          </div>
                        </div>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="border-t border-border/50 bg-secondary/20 px-3 py-1.5 text-[10px] text-muted-foreground">
                Enter / клик — открыть в новой вкладке
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
