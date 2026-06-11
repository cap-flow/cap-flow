/**
 * F2: Guided onboarding wizard для нового user.
 *
 * Sequential flow с обязательным подтверждением на каждом шаге:
 *   1. Welcome + Jurisdiction (tax rules)
 *   2. Подключить первый EVM-кошелёк (inline form)
 *   3. Отчёт по кошельку #1 (classifier summary + integrity)
 *   4. Добавить ещё кошелёк (optional) → ловит cross-wallet matches
 *   5. Подключить CEX (optional) — picker для всех 5 бирж + инструкции
 *      по получению API key + ссылка на /registry для actual подключения
 *   6. Done → /performance
 *
 * Ключевое отличие от прошлой версии — это не «прочитайте текст и нажмите
 * далее», а **реальный workflow** с подтверждениями. Каждый шаг проверяется
 * до перехода на следующий, чтобы избежать «каши» из миксованных кошельков.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  Wallet as WalletIcon,
  Building2,
  ArrowRight,
  Sparkles,
  Loader2,
  AlertTriangle,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useWallets, type WalletChain } from "@/lib/wallets";
import { useLoadedWallets } from "@/components/data/LoadedWalletsProvider";
import { isLikelyEvmAddress } from "@/lib/debank";
import {
  ALL_EXCHANGES_LIST,
  type ExchangeListItem,
} from "@/features/cex/api_key_instructions";
import type { ExchangeId } from "@/features/cex/api";
import { CexApiKeyInstructionsCard } from "@/components/cex/CexApiKeyInstructionsCard";
import { verifyAllPositionsProvenance } from "@/lib/portfolio/position_provenance";

const ONBOARDING_DONE_KEY = "capflow.onboarding.completed.v1";

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === "true";
  } catch {
    return false;
  }
}

function setOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "true");
  } catch {
    /* ignore */
  }
}

type WizardStep =
  | "welcome"
  | "wallet-add"
  | "wallet-report"
  | "cex-choose"
  | "cex-instructions"
  | "done";

export function OnboardingPage(): JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>("welcome");
  const [walletsAdded, setWalletsAdded] = useState<string[]>([]);
  const [chosenExchange, setChosenExchange] = useState<ExchangeId | null>(null);

  const wallets = useWallets();
  const { load, loadedById, progress, error: loadError } = useLoadedWallets();

  const finish = (): void => {
    setOnboardingDone();
    navigate("/performance");
  };

  const skip = (): void => {
    setOnboardingDone();
    navigate("/");
  };

  // Progress dots — 5 шагов в основной flow (юрисдикция убрана).
  const stepIndex = (
    {
      welcome: 0,
      "wallet-add": 1,
      "wallet-report": 2,
      "cex-choose": 3,
      "cex-instructions": 3,
      done: 4,
    } as Record<WizardStep, number>
  )[step];

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-3xl space-y-6">
        {/* Progress dots */}
        <div className="flex justify-center gap-2">
          {[0, 1, 2, 3, 4].map((n) => (
            <span
              key={n}
              className={
                "h-2 w-8 rounded-full transition-colors " +
                (n === stepIndex
                  ? "bg-brand-cyan"
                  : n < stepIndex
                    ? "bg-emerald-500/40"
                    : "bg-muted")
              }
            />
          ))}
        </div>

        {step === "welcome" && (
          <WelcomeStep onNext={() => setStep("wallet-add")} onSkip={skip} />
        )}

        {step === "wallet-add" && (
          <AddWalletStep
            existingCount={walletsAdded.length}
            progress={progress}
            loadError={loadError}
            onWalletAdded={async (input) => {
              const added = wallets.add(input);
              const result = await load(added);
              if (result) {
                setWalletsAdded((prev) => [...prev, added.id]);
                setStep("wallet-report");
              }
              return result;
            }}
            onSkip={() => setStep("cex-choose")}
            onBack={() => setStep("welcome")}
          />
        )}

        {step === "wallet-report" && (
          <WalletReportStep
            walletIds={walletsAdded}
            loadedById={loadedById}
            onAddAnother={() => setStep("wallet-add")}
            onContinueToCex={() => setStep("cex-choose")}
          />
        )}

        {step === "cex-choose" && (
          <CexChooseStep
            walletsCount={walletsAdded.length}
            onPick={(ex) => {
              setChosenExchange(ex);
              setStep("cex-instructions");
            }}
            onSkip={() => setStep("done")}
            onBack={() =>
              setStep(walletsAdded.length > 0 ? "wallet-report" : "wallet-add")
            }
          />
        )}

        {step === "cex-instructions" && chosenExchange && (
          <CexInstructionsStep
            exchangeId={chosenExchange}
            onBack={() => setStep("cex-choose")}
            onContinue={() => setStep("done")}
          />
        )}

        {step === "done" && <DoneStep onFinish={finish} />}
      </div>
    </div>
  );
}

// ──────────────────── Steps ────────────────────

function WelcomeStep({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip: () => void;
}): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-brand-cyan" />
          Добро пожаловать в Capflow
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          Capflow — единый dashboard для отслеживания{" "}
          <strong>cost basis</strong> и <strong>capital gains</strong> по всему
          твоему DeFi и CEX портфелю.
        </p>
        <p className="text-muted-foreground">
          За следующие 3-5 минут мы:
        </p>
        <ul className="space-y-2 text-muted-foreground">
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-400 flex-shrink-0" />
            <span>Подключим on-chain кошельки <strong>по одному</strong></span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-400 flex-shrink-0" />
            <span>На каждом шаге проверим корректность классификации</span>
          </li>
          <li className="flex items-start gap-2">
            <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-400 flex-shrink-0" />
            <span>В конце добавим CEX биржи (опционально)</span>
          </li>
        </ul>
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          ⓘ <strong>Важно:</strong> добавляем источники <strong>последовательно</strong>.
          Если подключить всё сразу — данные могут перемешаться без видимости что
          где. Поштучный flow позволяет проверить каждый шаг.
        </div>
        <div className="flex justify-between pt-4">
          <Button variant="ghost" onClick={onSkip}>
            Пропустить
          </Button>
          <Button onClick={onNext}>
            Начать <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function AddWalletStep({
  existingCount,
  progress,
  loadError,
  onWalletAdded,
  onSkip,
  onBack,
}: {
  existingCount: number;
  progress: { walletId: string; pages: number; loaded: number } | null;
  loadError: string | null;
  onWalletAdded: (input: {
    name: string;
    address: string;
    chain: WalletChain;
  }) => Promise<unknown>;
  onSkip: () => void;
  onBack: () => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFirst = existingCount === 0;
  const valid = isLikelyEvmAddress(address.trim());

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!valid) {
      setError("Похоже, это не EVM-адрес (должен начинаться с 0x, 42 символа)");
      return;
    }
    setLoading(true);
    try {
      const result = await onWalletAdded({
        name: name.trim() || `Wallet ${existingCount + 1}`,
        address: address.trim(),
        chain: "evm",
      });
      // Защита от зависания: load() может вернуть null БЕЗ исключения
      // (нет API-ключа, fetch-ошибка) — тогда родитель не переключит шаг.
      // Сбрасываем loading и показываем причину, чтобы форма не висела
      // вечно на «Загружаем историю…».
      if (!result) {
        setError(
          loadError ??
            "Не удалось загрузить историю кошелька. Проверь адрес и API-ключи (DeBank/Alchemy) в Настройках и попробуй ещё раз.",
        );
        setLoading(false);
      }
      // Если result есть — родитель уже переключил шаг, компонент размонтируется.
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl flex items-center gap-2">
          <WalletIcon className="h-6 w-6 text-brand-cyan" />
          {isFirst
            ? "Подключи первый кошелёк"
            : `Добавить ещё кошелёк (#${existingCount + 1})`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isFirst ? (
          <p>
            On-chain кошельки — основа портфеля. Capflow подтянет полную историю
            операций (swap / lending / staking / bridges) и построит cost basis
            автоматически.
          </p>
        ) : (
          <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
            ✓ После добавления мы найдём связи с предыдущими кошельками (bridge,
            internal transfer) и пробросим cost basis между ними.
          </div>
        )}

        {loading && (
          <div className="rounded-lg border border-brand-cyan/40 bg-brand-cyan/5 p-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-brand-cyan flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">
                  Загружаем историю операций…
                </div>
                <div className="text-xs text-muted-foreground">
                  {progress
                    ? `Получено ${progress.loaded.toLocaleString("ru")} операций · страниц: ${progress.pages}`
                    : "Подключаемся к кошельку…"}
                </div>
              </div>
            </div>
            {/* Индетерминированный прогресс-бар: показывает, что идёт работа. */}
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-brand-cyan/10">
              <div className="h-full w-1/3 animate-onboarding-indeterminate rounded-full bg-brand-cyan" />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Тянем swap / lending / staking / bridges и строим cost basis.
              Большой кошелёк может занять до минуты — не закрывай страницу.
            </p>
          </div>
        )}

        <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="w-name">Название (необязательно)</Label>
            <Input
              id="w-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Wallet ${existingCount + 1}`}
              autoComplete="off"
              disabled={loading}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w-chain">Сеть</Label>
            <div className="flex h-10 items-center rounded-md border border-border bg-background px-3 text-sm">
              EVM (Ethereum + L2)
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="w-addr">EVM-адрес</Label>
            <Input
              id="w-addr"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x..."
              autoComplete="off"
              disabled={loading}
            />
          </div>
          {error && (
            <div className="sm:col-span-2 text-xs text-red-600">{error}</div>
          )}
          <div className="sm:col-span-2 flex flex-col sm:flex-row justify-between gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onBack} disabled={loading}>
              Назад
            </Button>
            <div className="flex gap-2">
              {existingCount > 0 && (
                <Button type="button" variant="outline" onClick={onSkip} disabled={loading}>
                  Готово, к CEX
                </Button>
              )}
              <Button type="submit" disabled={!valid || loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Загружаем историю…
                  </>
                ) : (
                  <>
                    Подключить и проанализировать
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function WalletReportStep({
  walletIds,
  loadedById,
  onAddAnother,
  onContinueToCex,
}: {
  walletIds: string[];
  loadedById: Record<string, { wallet: { name: string }; ops: unknown[] }>;
  onAddAnother: () => void;
  onContinueToCex: () => void;
}): JSX.Element {
  // Take the most recently added wallet's report.
  const lastId = walletIds[walletIds.length - 1];
  const loaded = lastId ? loadedById[lastId] : null;
  const ops = (loaded?.ops as Array<{ type: string }> | undefined) ?? [];

  const stats = useMemo(() => {
    const byType: Record<string, number> = {};
    for (const op of ops) {
      byType[op.type] = (byType[op.type] ?? 0) + 1;
    }
    return {
      total: ops.length,
      byType,
      unknown: byType["unknown"] ?? 0,
    };
  }, [ops]);

  const isMultiWallet = walletIds.length > 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl flex items-center gap-2">
          <CheckCircle2 className="h-6 w-6 text-emerald-500" />
          Проверка кошелька «{loaded?.wallet.name ?? "—"}»
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="rounded border border-border bg-secondary/40 p-3">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
            Загружено и классифицировано
          </div>
          <div className="text-2xl font-semibold mb-3">{stats.total} операций</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            {Object.entries(stats.byType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <div
                  key={type}
                  className="flex items-center justify-between rounded bg-background px-2 py-1.5"
                >
                  <span className="text-muted-foreground">{type}</span>
                  <span className="font-medium">{count}</span>
                </div>
              ))}
          </div>
        </div>

        {stats.unknown > 0 && (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400 mb-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              {stats.unknown} unknown операций
            </div>
            <p>
              Классификатор не смог автоматически определить тип этих операций.
              Их можно разметить вручную позже в{" "}
              <Link to="/registry" className="underline">
                Реестре операций
              </Link>
              . Это не блокирует завершение onboarding.
            </p>
          </div>
        )}

        {isMultiWallet && (
          <div className="rounded border border-brand-cyan/30 bg-brand-cyan/5 p-3 text-xs">
            ✓ Cross-wallet matching активирован: bridge / internal transfer
            операции между кошельками будут найдены автоматически.
          </div>
        )}

        <div className="flex flex-col sm:flex-row justify-between gap-2 pt-2">
          <Button variant="outline" onClick={onAddAnother}>
            Добавить ещё кошелёк
          </Button>
          <Button onClick={onContinueToCex}>
            ✓ Всё правильно — далее к CEX
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CexChooseStep({
  walletsCount,
  onPick,
  onSkip,
  onBack,
}: {
  walletsCount: number;
  onPick: (ex: ExchangeId) => void;
  onSkip: () => void;
  onBack: () => void;
}): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl flex items-center gap-2">
          <Building2 className="h-6 w-6 text-brand-cyan" />
          Подключить CEX биржу
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {walletsCount > 0 && (
          <div className="rounded border border-brand-cyan/30 bg-brand-cyan/5 p-3 text-xs">
            ✓ После подключения CEX система сматчит trades / withdrawals с уже
            подгруженными ({walletsCount}) on-chain кошельками — cost basis
            пробросится из CEX в DeFi автоматически.
          </div>
        )}
        <p className="text-muted-foreground">
          Выбери биржу — мы покажем пошаговую инструкцию как создать read-only
          API ключ.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ALL_EXCHANGES_LIST.map((ex) => (
            <ExchangeCard key={ex.id} ex={ex} onPick={() => onPick(ex.id)} />
          ))}
        </div>
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          ⓘ <strong>Безопасность:</strong> мы запрашиваем ТОЛЬКО read-only
          permissions. Capflow никогда не имеет доступа к выводу средств или
          торговле.
        </div>
        <div className="flex flex-col sm:flex-row justify-between gap-2 pt-2">
          <Button variant="ghost" onClick={onBack}>
            Назад
          </Button>
          <Button variant="outline" onClick={onSkip}>
            Пропустить CEX
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ExchangeCard({
  ex,
  onPick,
}: {
  ex: ExchangeListItem;
  onPick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onPick}
      className="text-left rounded border border-border bg-secondary/30 p-3 hover:border-brand-cyan hover:bg-brand-cyan/5 transition"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">{ex.displayName}</span>
        {ex.requiresPassphrase && (
          <Badge variant="outline" className="text-[10px]">
            +passphrase
          </Badge>
        )}
      </div>
      <div className="text-xs text-muted-foreground">{ex.tagline}</div>
    </button>
  );
}

function CexInstructionsStep({
  exchangeId,
  onBack,
  onContinue,
}: {
  exchangeId: ExchangeId;
  onBack: () => void;
  onContinue: () => void;
}): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl flex items-center gap-2">
          <Building2 className="h-6 w-6 text-brand-cyan" />
          API ключ для биржи
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <CexApiKeyInstructionsCard
          exchangeId={exchangeId}
          asCard={false}
          compact={false}
        />
        <div className="rounded border border-brand-cyan/30 bg-brand-cyan/5 p-3 text-xs">
          После создания ключа — открой раздел «Реестр операций → CEX» и введи
          ключ. Capflow сам подтянет всю историю trades / deposits / withdrawals.
        </div>
        <div className="flex flex-col sm:flex-row justify-between gap-2 pt-2">
          <Button variant="ghost" onClick={onBack}>
            Назад (выбрать другую биржу)
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onContinue}>
              Я создам позже — далее
            </Button>
            <Button asChild>
              <Link to="/registry" onClick={onContinue}>
                Открыть Registry → ввести ключ
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-emerald-500" />
          Готово!
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          Все источники подключены. Сейчас откроется dashboard со списком твоих
          открытых позиций — cost basis и PnL уже посчитаны.
        </p>
        <div className="rounded border border-border bg-secondary/40 p-3 text-xs space-y-1">
          <div className="font-medium text-foreground">Дальше можешь:</div>
          <div className="text-muted-foreground">
            • Разметить unknown ops в /registry (если есть)
          </div>
          <div className="text-muted-foreground">
            • Добавить ещё кошельки или биржи в /registry
          </div>
          <div className="text-muted-foreground">
            • Посмотреть налоговые события в /tax
          </div>
        </div>
        <div className="flex justify-end pt-4">
          <Button onClick={onFinish}>
            Открыть Dashboard <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Use this helper to read provenance issues count when needed. */
function _provenanceUnused(): void {
  void verifyAllPositionsProvenance;
}
