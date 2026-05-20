/**
 * Раскрывающаяся карточка с пошаговой инструкцией по созданию API key
 * для конкретной CEX биржи. Показывает:
 *   - permissions которые нужно отметить (read-only)
 *   - permissions которые НЕ отмечать (security)
 *   - numbered steps
 *   - notes / частые проблемы
 *   - прямую ссылку на API management страницу биржи
 *
 * Используется в onboarding wizard'е и в `CexExchangesPanel` рядом с
 * полем ввода API key.
 */

import { ExternalLink, ShieldCheck, AlertTriangle, Info } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  getCexApiKeyInstructions,
  type CexApiKeyInstructions,
} from "@/features/cex/api_key_instructions";
import type { ExchangeId } from "@/features/cex/api";

interface Props {
  exchangeId: ExchangeId;
  /** Если задан — оборачивает в собственный Card. Иначе — без обёртки. */
  asCard?: boolean;
  /** Compact mode без notes/permissions. */
  compact?: boolean;
}

export function CexApiKeyInstructionsCard({
  exchangeId,
  asCard = true,
  compact = false,
}: Props): JSX.Element {
  const ins = getCexApiKeyInstructions(exchangeId);
  const inner = renderInner(ins, compact);
  if (!asCard) return <div className="space-y-4">{inner}</div>;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          Как создать API-ключ для {ins.displayName}
          <Badge variant="outline" className="text-[10px]">
            {ins.tradeHistoryLimitDays} дней истории
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">{inner}</CardContent>
    </Card>
  );
}

function renderInner(
  ins: CexApiKeyInstructions,
  compact: boolean,
): JSX.Element {
  return (
    <>
      {/* Прямая ссылка на API management */}
      <div className="flex items-center justify-between rounded border border-border bg-secondary/30 p-3">
        <div className="text-sm">
          <div className="font-medium">Откройте страницу API ключей:</div>
          <code className="text-xs text-muted-foreground">
            {ins.apiKeyPageUrl}
          </code>
        </div>
        <Button asChild size="sm" variant="outline">
          <a href={ins.apiKeyPageUrl} target="_blank" rel="noopener noreferrer">
            Открыть <ExternalLink className="ml-1 h-3 w-3" />
          </a>
        </Button>
      </div>

      {/* Permissions checklist */}
      {!compact && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="mb-2 flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              Отметить (read-only)
            </div>
            <ul className="space-y-1 text-xs">
              {ins.requiredPermissions.map((p) => (
                <li key={p} className="flex items-start gap-1.5">
                  <span className="mt-0.5 text-emerald-600">✓</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded border border-red-500/30 bg-red-500/5 p-3">
            <div className="mb-2 flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              НЕ отмечать (риск средств)
            </div>
            <ul className="space-y-1 text-xs">
              {ins.forbiddenPermissions.map((p) => (
                <li key={p} className="flex items-start gap-1.5">
                  <span className="mt-0.5 text-red-600">✗</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Numbered steps */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Пошагово
        </div>
        <ol className="space-y-2 text-sm">
          {ins.steps.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-cyan/15 text-[10px] font-semibold text-brand-cyan">
                {i + 1}
              </span>
              <span dangerouslySetInnerHTML={{ __html: highlightMd(step) }} />
            </li>
          ))}
        </ol>
      </div>

      {/* Notes */}
      {!compact && ins.notes.length > 0 && (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            <Info className="h-3.5 w-3.5" />
            Важно
          </div>
          <ul className="space-y-1 text-xs">
            {ins.notes.map((n, i) => (
              <li key={i} dangerouslySetInnerHTML={{ __html: highlightMd(n) }} />
            ))}
          </ul>
        </div>
      )}

      {/* Passphrase reminder */}
      {ins.requiresPassphrase && (
        <div className="rounded border border-brand-cyan/30 bg-brand-cyan/5 p-3 text-xs">
          ⓘ <strong>{ins.displayName}</strong> требует <strong>3 поля</strong>:
          API Key, Secret и Passphrase. Passphrase — это ваш собственный
          пароль для API, НЕ пароль аккаунта.
        </div>
      )}
    </>
  );
}

/** Простой mini-Markdown: **bold** → <strong>. */
function highlightMd(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
