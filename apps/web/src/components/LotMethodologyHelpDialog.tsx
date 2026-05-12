/**
 * Подробное пояснение FIFO / LIFO / WAC для новичка с примерами и
 * картинками-метафорами. Используется:
 *  - В OpenPositionsPage header — кнопка ⓘ рядом с глобальным toggle
 *  - В PurchaseHistoryPopup — кнопка "Подробнее" в разделе «📦 Методики»
 */

import { Dialog } from "@/components/ui/dialog";

export interface LotMethodologyHelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function LotMethodologyHelpDialog({
  open,
  onClose,
}: LotMethodologyHelpDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">Методики учёта покупок (FIFO / LIFO / WAC)</span>
          <span className="text-xs font-normal text-muted-foreground">
            Простое объяснение для начинающих
          </span>
        </div>
      }
    >
      <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto text-sm leading-relaxed">
        {/* Зачем нужны методики */}
        <section className="rounded-md border border-border/60 bg-secondary/20 px-3 py-3">
          <h3 className="mb-2 font-bold text-foreground">
            🤔 Зачем вообще нужны методики?
          </h3>
          <p className="mb-2 text-muted-foreground">
            Когда вы покупаете криптовалюту в разное время по разным ценам,
            каждая покупка превращается в отдельную «партию» (lot) со
            своей ценой:
          </p>
          <div className="mb-2 rounded bg-secondary/60 px-3 py-2 font-mono text-xs">
            Lot #1: 1 ETH куплено 15.01.2025 по $3,100
            <br />
            Lot #2: 5 ETH куплено 30.03.2026 по $2,050
            <br />
            Lot #3: 2 ETH куплено 12.04.2026 по $2,300
          </div>
          <p className="text-muted-foreground">
            Когда вы потом{" "}
            <strong className="text-foreground">тратите</strong> часть ETH
            (продаёте, переводите, кладёте в DeFi позицию) — система должна
            решить: <strong className="text-foreground">из какой партии
            вычесть</strong>?
          </p>
          <p className="mt-1 text-muted-foreground">
            Это важно, потому что у каждой партии своя цена покупки. От
            выбора партии зависит сколько вы «реально потратили» на то что
            осталось.
          </p>
        </section>

        {/* FIFO */}
        <section className="rounded-md border border-success/40 bg-success/5 px-3 py-3">
          <h3 className="mb-2 font-bold text-success">
            🥇 FIFO — First In, First Out (рекомендуется)
          </h3>
          <p className="mb-2 text-muted-foreground">
            «Первый пришёл, первый ушёл» — как очередь в магазине: кто раньше
            пришёл, того раньше обслужили.
          </p>
          <p className="mb-2 text-muted-foreground">
            При тратах берём из{" "}
            <strong className="text-foreground">самой старой партии</strong>.
            Когда она кончается — переходим к следующей по времени.
          </p>
          <div className="mb-2 rounded bg-secondary/60 px-3 py-2 text-xs">
            <p className="mb-1 font-semibold text-foreground">Пример:</p>
            <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">
              <li>Купили 1 ETH @ $3,100 (Jan 2025)</li>
              <li>Купили 5 ETH @ $2,050 (Mar 2026)</li>
              <li>Положили 4 ETH в Aave (Apr 2026)</li>
            </ol>
            <p className="mt-2 text-foreground">
              <strong>FIFO берёт первыми старые ETH:</strong>
            </p>
            <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
              <li>1 ETH из Lot #1 ($3,100) → потрачено $3,100</li>
              <li>3 ETH из Lot #2 ($2,050) → потрачено $6,150</li>
            </ul>
            <p className="mt-1 text-foreground">
              <strong>Стоимость 4 ETH в Aave = $9,250</strong>
            </p>
            <p className="mt-1 text-muted-foreground">
              В кошельке остались: 2 ETH из Lot #2 ($2,050)
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">Когда выбрать:</strong>{" "}
            универсальный стандарт. Используется по умолчанию в США (IRS),
            разрешён везде включая EU/IFRS. Самый интуитивный — старые
            расходы первыми.
          </p>
        </section>

        {/* LIFO */}
        <section className="rounded-md border border-orange-400/40 bg-orange-400/5 px-3 py-3">
          <h3 className="mb-2 font-bold text-orange-400">
            🔄 LIFO — Last In, First Out
          </h3>
          <p className="mb-2 text-muted-foreground">
            «Последний пришёл, первый ушёл» — как стопка тарелок: моете ту,
            что положили сверху последней.
          </p>
          <p className="mb-2 text-muted-foreground">
            При тратах берём из{" "}
            <strong className="text-foreground">самой новой партии</strong>.
          </p>
          <div className="mb-2 rounded bg-secondary/60 px-3 py-2 text-xs">
            <p className="mb-1 font-semibold text-foreground">
              Тот же пример с LIFO:
            </p>
            <p className="text-foreground">
              <strong>LIFO берёт первыми новые ETH:</strong>
            </p>
            <ul className="ml-4 list-disc space-y-0.5 text-muted-foreground">
              <li>4 ETH из Lot #2 ($2,050) → потрачено $8,200</li>
            </ul>
            <p className="mt-1 text-foreground">
              <strong>Стоимость 4 ETH в Aave = $8,200</strong>
            </p>
            <p className="mt-1 text-muted-foreground">
              В кошельке остались: 1 ETH из Lot #1 ($3,100) + 1 ETH из Lot
              #2 ($2,050)
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">Когда выбрать:</strong> для
            tax-оптимизации в США (разрешён). Минимизирует realized gain в
            растущем рынке.{" "}
            <strong className="text-destructive">Запрещён в IFRS</strong>{" "}
            (EU и большинство стран).
          </p>
        </section>

        {/* WAC */}
        <section className="rounded-md border border-brand-cyan/40 bg-brand-cyan/5 px-3 py-3">
          <h3 className="mb-2 font-bold text-brand-cyan">
            📊 WAC — Weighted Average Cost
          </h3>
          <p className="mb-2 text-muted-foreground">
            «Средневзвешенная цена» — все партии перемешиваются в одну
            «среднюю». Не отслеживаем какая партия откуда — просто берём
            среднюю цену.
          </p>
          <p className="mb-2 text-muted-foreground">
            При тратах списываем по{" "}
            <strong className="text-foreground">текущей средней цене</strong>{" "}
            всех имеющихся ETH.
          </p>
          <div className="mb-2 rounded bg-secondary/60 px-3 py-2 text-xs">
            <p className="mb-1 font-semibold text-foreground">
              Тот же пример с WAC:
            </p>
            <p className="text-muted-foreground">
              Средняя цена = (1×$3,100 + 5×$2,050) / 6 = $13,350 / 6 ={" "}
              <strong className="text-foreground">$2,225/ETH</strong>
            </p>
            <p className="mt-1 text-foreground">
              <strong>4 ETH в Aave × $2,225 = $8,900</strong>
            </p>
            <p className="mt-1 text-muted-foreground">
              В кошельке осталось: 2 ETH с той же WAC $2,225
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong className="text-foreground">Когда выбрать:</strong> когда
            audit-trail (история конкретных партий) не важен. Простой
            расчёт. Используется в некоторых tax юрисдикциях. Менее точен
            чем FIFO для DeFi-трекинга.
          </p>
        </section>

        {/* Сравнение */}
        <section className="rounded-md border border-border/60 bg-secondary/20 px-3 py-3">
          <h3 className="mb-2 font-bold text-foreground">
            📊 Итоговое сравнение для нашего примера
          </h3>
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-2 py-1 text-left">Метод</th>
                <th className="px-2 py-1 text-right">Стоимость 4 ETH в Aave</th>
                <th className="px-2 py-1 text-right">Что осталось</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border/40">
                <td className="px-2 py-1 font-semibold text-success">FIFO</td>
                <td className="px-2 py-1 text-right">$9,250</td>
                <td className="px-2 py-1 text-right text-muted-foreground">
                  2 ETH @ $2,050
                </td>
              </tr>
              <tr className="border-b border-border/40">
                <td className="px-2 py-1 font-semibold text-orange-400">LIFO</td>
                <td className="px-2 py-1 text-right">$8,200</td>
                <td className="px-2 py-1 text-right text-muted-foreground">
                  1 ETH @ $3,100 + 1 ETH @ $2,050
                </td>
              </tr>
              <tr>
                <td className="px-2 py-1 font-semibold text-brand-cyan">WAC</td>
                <td className="px-2 py-1 text-right">$8,900</td>
                <td className="px-2 py-1 text-right text-muted-foreground">
                  2 ETH @ $2,225 (среднее)
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            Видно: разные методики дают{" "}
            <strong className="text-foreground">разные числа</strong> — это
            нормально. Важно <strong>выбрать одну и придерживаться её</strong>{" "}
            для всех расчётов, чтобы быть consistent.
          </p>
        </section>

        {/* Рекомендация */}
        <section className="rounded-md border border-success/40 bg-success/10 px-3 py-3">
          <h3 className="mb-1 font-bold text-success">✨ Что выбрать?</h3>
          <p className="mb-1 text-foreground">
            <strong>FIFO</strong> — рекомендация для большинства пользователей.
          </p>
          <ul className="ml-4 list-disc space-y-0.5 text-xs text-muted-foreground">
            <li>Tax-стандарт IRS (USA), разрешён в EU/IFRS</li>
            <li>Самый стабильный — в долгосроке сводится к реальной средней</li>
            <li>Интуитивно понятен: «старое потратил, новое осталось»</li>
            <li>Лучшая audit-trail для отчётности</li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            LIFO/WAC — только если есть конкретные причины (tax-optimization
            в US или упрощённая модель). Если сомневаетесь — оставляйте FIFO.
          </p>
        </section>
      </div>
    </Dialog>
  );
}
