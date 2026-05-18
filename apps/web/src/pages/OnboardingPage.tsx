/**
 * F2: onboarding flow для нового user.
 *
 * 4-step wizard:
 *   1. Welcome — кто мы и что user получит
 *   2. Jurisdiction — выбор страны для tax rules (T5)
 *   3. Connect wallet — CTA в Registry
 *   4. (Optional) Connect CEX — CTA на CEX setup
 *
 * Состояние шага хранится в localStorage чтобы user мог вернуться позже.
 * После завершения — redirect на dashboard. Если user уже завершил —
 * AppShell скрывает onboarding entry.
 *
 * Идея: показать first-value experience в первые 5 минут (Registry wizard
 * подтянет историю — user видит cost basis / positions / tax events).
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  Wallet as WalletIcon,
  Building2,
  Globe,
  ArrowRight,
  Sparkles,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  JURISDICTIONS,
  getJurisdictionConfig,
  type Jurisdiction,
} from "@/lib/portfolio/tax_jurisdictions";

const ONBOARDING_DONE_KEY = "capflow.onboarding.completed.v1";
const ONBOARDING_JURISDICTION_KEY = "capflow.preferences.jurisdiction";

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
    // ignore (private browsing)
  }
}

function setPreferredJurisdiction(j: Jurisdiction): void {
  try {
    localStorage.setItem(ONBOARDING_JURISDICTION_KEY, j);
  } catch {
    // ignore
  }
}

type Step = 1 | 2 | 3 | 4;

export function OnboardingPage(): JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>("US");

  const next = (): void => setStep((s) => (s + 1) as Step);
  const prev = (): void => setStep((s) => Math.max(1, s - 1) as Step);

  const finish = (): void => {
    setPreferredJurisdiction(jurisdiction);
    setOnboardingDone();
    navigate("/");
  };

  const skip = (): void => {
    setOnboardingDone();
    navigate("/");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-2xl space-y-6">
        {/* Progress dots */}
        <div className="flex justify-center gap-2">
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              className={
                "h-2 w-8 rounded-full transition-colors " +
                (n === step
                  ? "bg-brand-cyan"
                  : n < step
                    ? "bg-emerald-500/40"
                    : "bg-muted")
              }
            />
          ))}
        </div>

        {step === 1 && (
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
                <strong>cost basis</strong> и{" "}
                <strong>capital gains</strong> по всему твоему DeFi и CEX
                портфелю.
              </p>
              <p className="text-muted-foreground">
                За следующие 5 минут мы:
              </p>
              <ul className="space-y-2 text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-400 flex-shrink-0" />
                  <span>Подключим первый on-chain wallet</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-400 flex-shrink-0" />
                  <span>(опционально) Подключим CEX exchange</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-400 flex-shrink-0" />
                  <span>Покажем твой dashboard</span>
                </li>
              </ul>
              <div className="flex justify-between pt-4">
                <Button variant="ghost" onClick={skip}>
                  Пропустить
                </Button>
                <Button onClick={next}>
                  Начать
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl flex items-center gap-2">
                <Globe className="h-6 w-6 text-brand-cyan" />
                Налоговая юрисдикция
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>
                Выбери страну — это определит правила расчёта налогов: holding
                period, разрешённые методики (FIFO/HIFO/WAC), token-to-token
                treatment.
              </p>
              <div className="space-y-2">
                {JURISDICTIONS.map((j) => {
                  const cfg = getJurisdictionConfig(j);
                  return (
                    <label
                      key={j}
                      className={
                        "flex items-start gap-3 rounded border p-3 cursor-pointer transition " +
                        (jurisdiction === j
                          ? "border-brand-cyan bg-brand-cyan/5"
                          : "border-border hover:bg-accent/30")
                      }
                    >
                      <input
                        type="radio"
                        name="jurisdiction"
                        value={j}
                        checked={jurisdiction === j}
                        onChange={() => setJurisdiction(j)}
                        className="mt-0.5 accent-brand-cyan"
                      />
                      <div className="flex-1">
                        <div className="font-medium">{cfg.label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {cfg.notes}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                ⚠ Software model — не legal advice. Для filing проконсультируйся
                с tax advisor.
              </p>
              <div className="flex justify-between pt-4">
                <Button variant="ghost" onClick={prev}>
                  Назад
                </Button>
                <Button onClick={next}>
                  Далее
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl flex items-center gap-2">
                <WalletIcon className="h-6 w-6 text-brand-cyan" />
                Подключи первый wallet
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>
                On-chain wallets (EVM / Solana) — основа портфеля. Capflow
                подтянет полную историю операций (swap / lending / staking /
                bridges) и построит cost basis автоматически.
              </p>
              <div className="rounded border border-border bg-secondary/40 p-3 space-y-2 text-xs">
                <p className="font-medium text-foreground">Что готовится за тебя:</p>
                <ul className="space-y-1 text-muted-foreground">
                  <li>✓ Multi-chain support: ETH / Arbitrum / Base / Polygon / BSC / Solana</li>
                  <li>✓ DeBank / Helius integration для on-chain history</li>
                  <li>✓ Авто-классификация (swap / LP / lending / rewards)</li>
                  <li>✓ Cross-wallet matching (internal transfers, bridges, cycles)</li>
                </ul>
              </div>
              <div className="flex flex-col sm:flex-row justify-between gap-2 pt-4">
                <Button variant="ghost" onClick={prev}>
                  Назад
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={next}>
                    Пропустить
                  </Button>
                  <Button asChild>
                    <Link to="/registry" onClick={setOnboardingDone}>
                      Открыть Registry
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl flex items-center gap-2">
                <Building2 className="h-6 w-6 text-brand-cyan" />
                CEX exchange (опционально)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>
                Если ты торгуешь на Binance / Bybit / OKX / Bitget / MEXC —
                подключи через read-only API key. Capflow подтянет trades,
                transfers, P2P и свяжет CEX side с on-chain (cost basis flows
                end-to-end через UCB C1/C2).
              </p>
              <div className="rounded border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                💡 Это нужно только если у тебя есть централизованные exchange
                accounts. Pure on-chain user может смело пропустить.
              </div>
              <div className="flex flex-col sm:flex-row justify-between gap-2 pt-4">
                <Button variant="ghost" onClick={prev}>
                  Назад
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={finish}>
                    Завершить
                  </Button>
                  <Button asChild>
                    <Link to="/registry" onClick={finish}>
                      Подключить CEX
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
