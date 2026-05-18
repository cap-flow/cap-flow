import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useActiveAccount,
  useMyAccounts,
  useSwitchAccount,
} from "@/features/accounts/hooks";
import { api } from "@/lib/api/client";
import { accountSchema, type Account } from "@/features/accounts/api";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

/**
 * Topbar account switcher.
 *
 * Visible only when the user has more than one account (single-account users
 * see nothing — no UI clutter). Clicking opens a dropdown listing all active
 * (non-archived) accounts; the current one is checkmarked. A "Создать новый
 * аккаунт" entry at the bottom opens a tiny modal — name + optional
 * description, POSTs `/v1/accounts`, then auto-switches to it.
 *
 * Persistence + invalidation logic lives in `useSwitchAccount` so this
 * component stays presentational.
 */
export function AccountSwitcher(): JSX.Element | null {
  const myAccounts = useMyAccounts();
  const active = useActiveAccount();
  const switchTo = useSwitchAccount();
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const accounts = (myAccounts.data ?? []).filter((a) => !a.archivedAt);

  // Hide entirely while we're still loading the first list — no point
  // flashing a partial switcher during the initial render.
  if (myAccounts.isLoading) return null;

  // Single-account users don't see the switcher. If we want to expose
  // "Создать ещё один аккаунт" for them later, flip this guard — but
  // the canonical home for that is Settings → Дополнительно.
  if (accounts.length <= 1) return null;

  const current = active ?? accounts[0];
  if (!current) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-sm transition-colors",
          "hover:bg-accent",
          open && "bg-accent"
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Текущий аккаунт: ${current.name}`}
      >
        <Wallet className="h-3.5 w-3.5 text-brand-cyan" />
        <span className="max-w-[140px] truncate font-medium">
          {current.name}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-1 w-72 overflow-hidden rounded-md border border-border bg-card shadow-lg"
          role="listbox"
        >
          <div className="border-b border-border bg-card/80 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Переключить аккаунт
          </div>
          {accounts.map((acc) => (
            <button
              key={acc.id}
              type="button"
              onClick={() => {
                switchTo(acc.id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors",
                acc.id === current.id
                  ? "bg-brand-cyan/10"
                  : "hover:bg-accent"
              )}
            >
              <Check
                className={cn(
                  "mt-0.5 h-3.5 w-3.5 shrink-0",
                  acc.id === current.id
                    ? "text-brand-cyan"
                    : "text-transparent"
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-foreground">
                    {acc.name}
                  </span>
                  {acc.isPrimary && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                      primary
                    </span>
                  )}
                </div>
                {acc.description && (
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {acc.description}
                  </div>
                )}
              </div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
            className="flex w-full items-center gap-2 border-t border-border bg-card/60 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Создать новый аккаунт
          </button>
        </div>
      )}

      <CreateAccountDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(acc) => {
          // Refresh the accounts list, then auto-switch to the new one.
          qc.invalidateQueries({ queryKey: ["accounts"] });
          switchTo(acc.id);
          setCreateOpen(false);
        }}
      />
    </div>
  );
}

function CreateAccountDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (acc: Account) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const created = await api.post<Account, { name: string; description: string | null }>(
        "/v1/accounts",
        {
          name: name.trim(),
          description: description.trim() || null,
        },
        accountSchema
      );
      onCreated(created);
      setName("");
      setDescription("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Создать новый аккаунт"
      description="Каждый аккаунт хранит свой набор кошельков, операций и метрик независимо. Между ними можно переключаться через меню в верхней панели."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={handleSubmit} disabled={busy || !name.trim()}>
            {busy ? "Создаём…" : "Создать"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3 text-sm">
        <div className="space-y-1.5">
          <Label htmlFor="new-acc-name">Название</Label>
          <Input
            id="new-acc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: Спекулятивный портфель"
            required
            autoFocus
            disabled={busy}
            maxLength={120}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-acc-desc">Описание (опционально)</Label>
          <Input
            id="new-acc-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Зачем выделили в отдельный аккаунт"
            disabled={busy}
            maxLength={500}
          />
        </div>
        {err && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {err}
          </p>
        )}
      </form>
    </Dialog>
  );
}
