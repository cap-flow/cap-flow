import { Check, Circle, ExternalLink, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/features/auth/AuthProvider";
import { useWallets } from "@/lib/wallets";
import { cn } from "@/lib/utils";

/**
 * M17 (2026-05-14): onboarding checklist.
 *
 * Shows a 3-step checklist on HomePage until each step is satisfied
 * (or the user dismisses the card with X). Designed to fight the
 * ~70% drop-off on day-1 — new users see an empty dashboard, don't
 * know what to do next, and leave.
 *
 * Steps (in order):
 *   1. Verify email — must be done first; gates everything
 *   2. Add at least one wallet — without this nothing shows
 *   3. Run the first refresh — populates data
 *
 * Auto-hides when all three are done. Per-user dismissal via
 * localStorage so a returning user doesn't see the card forever
 * after they manually closed it.
 */

interface ChecklistStep {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly done: boolean;
  readonly action?: { label: string; to: string } | undefined;
}

const DISMISS_KEY = "capflow.onboarding.dismissedFor";

export function OnboardingChecklist(): JSX.Element | null {
  const { user } = useAuth();
  const { state: wallets } = useWallets();
  const [dismissed, setDismissed] = useState(false);

  // Per-user dismiss: stored as user.id. If a different user logs in
  // on the same browser, they start with a fresh checklist.
  useEffect(() => {
    if (!user) return;
    try {
      const stored = localStorage.getItem(DISMISS_KEY);
      setDismissed(stored === user.id);
    } catch {
      /* localStorage blocked */
    }
  }, [user]);

  if (!user) return null;

  const steps: ChecklistStep[] = [
    // 2026-05-25 (user request): temporarily убираем "Подтвердите email"
    // из onboarding checklist. Чтобы вернуть — раскомментировать.
    // {
    //   key: "verify",
    //   label: "Подтвердите email",
    //   description:
    //     "Без подтверждения вы не сможете восстановить пароль или получать важные уведомления.",
    //   done: !!user.emailVerifiedAt,
    //   action: user.emailVerifiedAt
    //     ? undefined
    //     : { label: "Открыть Настройки", to: "/settings" },
    // },
    {
      key: "wallet",
      label: "Добавьте первый кошелёк",
      description:
        "Подключите EVM или Solana адрес — мы автоматически подтянем баланс и историю операций.",
      done: wallets.list.length > 0,
      action:
        wallets.list.length > 0
          ? undefined
          : { label: "Добавить кошелёк", to: "/registry" },
    },
    {
      key: "explore",
      label: "Изучите Performance",
      description:
        "После первого refresh откройте раздел «Performance» — там видны открытые позиции с PnL и Fee-lifetime по каждому протоколу.",
      done: wallets.list.length > 0, // mark done once at least the prereq is satisfied
      action:
        wallets.list.length > 0
          ? { label: "Открыть Performance", to: "/performance" }
          : undefined,
    },
  ];

  const allDone = steps.every((s) => s.done);
  if (allDone || dismissed) return null;

  function handleDismiss() {
    if (!user) return;
    try {
      localStorage.setItem(DISMISS_KEY, user.id);
    } catch {
      /* quota — non-fatal, stays visible until reload */
    }
    setDismissed(true);
  }

  const doneCount = steps.filter((s) => s.done).length;

  return (
    <Card className="border-brand-cyan/40 bg-brand-cyan/5">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">
              Добро пожаловать в Capflow! 👋
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {doneCount} из {steps.length} шагов выполнено. Это меню
              исчезнет автоматически, когда вы завершите всё.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Скрыть подсказку"
            title="Скрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ul className="mt-4 space-y-2">
          {steps.map((step) => (
            <li
              key={step.key}
              className={cn(
                "flex items-start gap-3 rounded-md border border-border bg-card/60 p-3",
                step.done && "opacity-60",
              )}
            >
              <div className="mt-0.5 shrink-0">
                {step.done ? (
                  <Check className="h-5 w-5 text-success" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "text-sm font-semibold",
                    step.done && "line-through",
                  )}
                >
                  {step.label}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {step.description}
                </div>
              </div>
              {step.action && !step.done && (
                <Button asChild size="sm" variant="outline" className="shrink-0">
                  <Link to={step.action.to}>
                    {step.action.label}
                    <ExternalLink className="ml-1 h-3 w-3" />
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
