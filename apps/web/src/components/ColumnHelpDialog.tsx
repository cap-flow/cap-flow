/**
 * Объяснения каждой колонки таблицы Открытые позиции для новичка.
 * Открывается при клике на ? рядом с заголовком колонки.
 *
 * Цель — дать понятное объяснение БЕЗ технических терминов. Если термин
 * нужен — он сразу объясняется простыми словами с аналогией.
 */

import { Dialog } from "@/components/ui/dialog";

export interface ColumnHelp {
  /** Id колонки. */
  id: string;
  /** Заголовок колонки (как в таблице). */
  title: string;
  /** Короткое описание — 1 предложение. */
  short: string;
  /** Подробное объяснение. JSX для форматирования. */
  detailed: React.ReactNode;
}

const COLUMN_HELPS: Record<string, ColumnHelp> = {
  id: {
    id: "id",
    title: "ID",
    short: "Номер позиции в списке",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Это просто номер строки —{" "}
          <strong className="text-foreground">POS-001, POS-002, POS-003…</strong>{" "}
          Чтобы быстро ссылаться на конкретную позицию.
        </p>
        <p>
          Например, если у вас 7 позиций — они пронумерованы от POS-001 до
          POS-007. Номера могут поменяться когда вы добавите/удалите кошелёк.
        </p>
      </div>
    ),
  },
  openedAt: {
    id: "openedAt",
    title: "Дата открытия",
    short: "Когда вы впервые положили деньги в эту позицию",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Дата когда вы первый раз{" "}
          <strong className="text-foreground">положили актив</strong> в этот
          DeFi-проект.
        </p>
        <p>
          Например: 30.03.2026 — значит вы добавили актив в Aave/Uniswap/
          Fluid именно в этот день.
        </p>
        <p>
          Если вы потом добавляли ещё денег в ту же позицию — здесь
          останется ПЕРВАЯ дата. Это нужно чтобы посчитать сколько дней
          уже работает позиция.
        </p>
      </div>
    ),
  },
  ageDays: {
    id: "ageDays",
    title: "Срок",
    short: "Сколько дней позиция уже работает",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Просто разница между сегодня и датой открытия.
        </p>
        <p>
          Например: <strong>41 дн.</strong> = позицию открыли 41 день
          назад.
        </p>
        <p>
          Используется чтобы посчитать «годовую доходность»: чем дольше
          позиция работает, тем точнее видно реальную доходность.
        </p>
      </div>
    ),
  },
  wallet: {
    id: "wallet",
    title: "Кошелёк",
    short: "В каком вашем кошельке лежит эта позиция",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Просто имя кошелька — то которое вы задали при подключении в
          Capflow.
        </p>
        <p>
          Если у вас несколько кошельков (например, основной и трейдерский)
          — здесь видно <strong>где именно</strong> лежит каждая позиция.
          Удобно для разделения активов по разным целям или людям.
        </p>
      </div>
    ),
  },
  chain: {
    id: "chain",
    title: "Сеть",
    short: "На каком блокчейне работает позиция",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Криптовалюты живут на разных «дорогах» (блокчейнах). Каждая
          сеть — это отдельная экосистема со своими комиссиями за
          транзакции (газ).
        </p>
        <ul className="ml-4 list-disc space-y-0.5">
          <li>
            <strong>ETH</strong> — Ethereum, главная сеть. Самые высокие
            комиссии ($5-30 за транзакцию)
          </li>
          <li>
            <strong>ARB</strong> — Arbitrum. То же что Ethereum, но
            комиссии в 10-50 раз меньше
          </li>
          <li>
            <strong>BASE</strong> — Base от Coinbase. Тоже дешёвая
          </li>
          <li>
            <strong>OP</strong> — Optimism, <strong>MATIC</strong> —
            Polygon, <strong>BSC</strong> — Binance Smart Chain
          </li>
        </ul>
      </div>
    ),
  },
  protocol: {
    id: "protocol",
    title: "Протокол",
    short: "Какой DeFi-сервис вы используете",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Название DeFi-приложения которое работает с вашими активами.
          Это как «банк» в крипте, но без банка — управляется кодом.
        </p>
        <p>
          Примеры:
        </p>
        <ul className="ml-4 list-disc space-y-0.5">
          <li>
            <strong>Aave / Compound / Fluid</strong> — кладёте актив,
            получаете проценты (как депозит)
          </li>
          <li>
            <strong>Uniswap V3</strong> — даёте свои токены в «обменник»,
            получаете комиссию с каждого обмена
          </li>
          <li>
            <strong>GMX / Pendle</strong> — более сложные продукты с
            фиксированной доходностью или плечом
          </li>
        </ul>
        <p>
          Если позиция связана с долгом (брали в займы) — под названием
          показан <strong className="text-foreground">HF X.XX</strong>{" "}
          (Health Factor — индикатор риска ликвидации).
        </p>
        <p className="text-[11px]">
          HF &gt; 2 — безопасно. HF 1.5–2 — следить. HF &lt; 1.3 —
          опасность, могут забрать залог.
        </p>
      </div>
    ),
  },
  kind: {
    id: "kind",
    title: "Тип",
    short: "Что делает ваша позиция в DeFi",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>Простая категоризация — что вы вообще делаете:</p>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>LP</strong> (Liquidity Pool) — даёте свои токены в пул
            обменника. Зарабатываете комиссии с каждого обмена. Похоже на
            то как обменники в реале берут разницу — только теперь это вы.
          </li>
          <li>
            <strong>Лендинг</strong> — даёте актив в долг другим
            пользователям через протокол. Получаете проценты. Как банковский
            депозит, только без банка.
          </li>
          <li>
            <strong>Стейкинг</strong> — заблокировали токен в смарт-
            контракте, получаете награды.
          </li>
          <li>
            <strong>Перп</strong> (perpetual) — открыли позицию с плечом
            на рост или падение цены. Высокий риск.
          </li>
        </ul>
      </div>
    ),
  },
  capital: {
    id: "capital",
    title: "Капитал",
    short: "Использовали свои деньги или взятые в долг?",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          <strong className="text-foreground">СВОЙ</strong> — позиция
          открыта на ваши собственные деньги. По умолчанию все позиции
          такие.
        </p>
        <p>
          <strong className="text-foreground">КРЕДИТ</strong> — деньги для
          этой позиции были взяты в займы (например, заняли USDT через
          Aave под залог другого актива). Чтобы пометить позицию как
          кредитную — нажмите кнопку в этом столбце.
        </p>
        <p>
          Зачем это нужно: Capflow в Сводке считает отдельно «свой
          капитал» (что у вас реально есть) и «кредитный» (что вы должны
          вернуть). Это даёт правильную картину чистого капитала.
        </p>
      </div>
    ),
  },
  tokenId: {
    id: "tokenId",
    title: "TokenId / NFT",
    short: "Уникальный номер вашей LP-позиции",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          В Uniswap V3 каждая ваша LP-позиция — это{" "}
          <strong className="text-foreground">NFT</strong> (уникальный
          цифровой объект) с конкретным номером.
        </p>
        <p>
          Например <strong>#5417295</strong> — ваш номер позиции в Uniswap.
          По нему можно найти позицию на блокчейн-эксплорерах (Etherscan,
          Revert Finance) и посмотреть все детали.
        </p>
        <p>
          Для других протоколов (например Aave/Fluid) этот столбец пустой
          — там у вас нет уникального номера, позиция определяется
          адресом кошелька + типом актива.
        </p>
      </div>
    ),
  },
  supplyTokens: {
    id: "supplyTokens",
    title: "Состав позиции",
    short: "Какие активы и сколько лежит в позиции прямо сейчас",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>Список токенов и их количество в текущий момент.</p>
        <p>
          Например: <strong>5.147718 ETH</strong> — у вас в этой позиции
          сейчас 5.15 ETH.
        </p>
        <p>
          В V3 LP пулах состав может меняться сам по себе:{" "}
          <strong>0.521 WETH + 799 USDC</strong> — обменник держит
          одновременно оба токена в пропорции, которая зависит от текущей
          цены пары. Если цена сильно ушла, можете оказаться в 100% одного
          токена.
        </p>
        <p>
          В лендингах (Aave/Fluid) количество может медленно расти со
          временем — это начисляется доходность. Например в начале было 5
          ETH, через год может стать 5.15 ETH.
        </p>
      </div>
    ),
  },
  startUsd: {
    id: "startUsd",
    title: "Стартовая $",
    short: "Сколько вы реально потратили на эти токены",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Это сумма ваших{" "}
          <strong className="text-foreground">реальных затрат</strong> на
          покупку токенов которые сейчас в позиции.
        </p>
        <p>
          <strong className="text-foreground">Пример:</strong> вы купили
          5 ETH когда они стоили $2,000 каждый — потратили $10,000. Потом
          положили эти 5 ETH в Aave. Стартовая $ = $10,000.
        </p>
        <p>
          Capflow смотрит вашу историю покупок и считает по средней цене
          (методика выбирается в шапке: FIFO / LIFO / WAC).
        </p>
        <div className="rounded bg-secondary/40 px-2 py-1.5">
          <p className="font-medium text-foreground">
            ⓘ Нажмите ? рядом со значением (для lending позиций):
          </p>
          <p className="mt-0.5">
            Откроется детальная история — какие именно покупки попали в
            эту позицию и их средняя цена.
          </p>
        </div>
        <p>
          Для LP V3 — считается через цену пула в момент когда вы клали
          активы (это самая точная цена с блокчейна).
        </p>
      </div>
    ),
  },
  currentUsd: {
    id: "currentUsd",
    title: "Текущая $",
    short: "Сколько ваша позиция стоит сегодня в долларах",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Текущая рыночная стоимость позиции — берёт количество токенов и
          умножает на сегодняшнюю цену.
        </p>
        <p>
          <strong className="text-foreground">Пример:</strong> в позиции 5
          ETH, сегодня ETH стоит $2,300 → Текущая $ = $11,500.
        </p>
        <p>
          Сравнивая со «Стартовая $», сразу видно зарабатываете вы или
          теряете на изменении цены.
        </p>
        <p>
          В лендингах эта сумма растёт сама со временем — потому что
          количество токенов увеличивается за счёт начисляемой доходности.
        </p>
      </div>
    ),
  },
  pnl: {
    id: "pnl",
    title: "PnL позиций",
    short: "Прибыль или убыток ТОЛЬКО от изменения цены",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          PnL = Profit and Loss = прибыль/убыток.
        </p>
        <p>
          <strong className="text-foreground">Текущая $ − Стартовая $</strong>{" "}
          = сколько вы заработали или потеряли на движении цены актива.
        </p>
        <p>
          <strong className="text-foreground">Пример:</strong> положили на
          $10,000, сейчас $11,500 → +$1,500 (зелёным).
        </p>
        <p>
          Положили на $10,000, сейчас $9,000 → -$1,000 (красным).
        </p>
        <p>
          ⚠️ Важно: это{" "}
          <strong className="text-foreground">не учитывает</strong> комиссии
          и доходность которые вы успели заработать. Для полной картины
          смотрите{" "}
          <strong className="text-foreground">Total PnL</strong> — там и
          цена, и доход.
        </p>
      </div>
    ),
  },
  fee: {
    id: "fee",
    title: "Fee",
    short: "Сколько комиссий и процентов вы заработали в позиции",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Сумма всех денег которые вам «капают» за работу позиции.
        </p>
        <p>
          Из чего складывается:
        </p>
        <ul className="ml-4 list-disc space-y-1">
          <li>
            <strong>Pending</strong> — ещё лежит внутри позиции, можно
            забрать в любой момент. Например, в Uniswap V3 — это
            комиссии с обменов которые накопились на NFT и ждут когда
            вы их «соберёте».
          </li>
          <li>
            <strong>Claimed</strong> — уже забрали себе, эти деньги уже
            на кошельке.
          </li>
        </ul>
        <p>
          Для лендинга (Aave/Fluid) — это процент по «депозиту»: сколько
          ваши aToken выросли в количестве × текущая цена.
        </p>
        <p>
          <strong className="text-foreground">Пример:</strong> +$45 за 30
          дней работы позиции = неплохой пассивный доход.
        </p>
      </div>
    ),
  },
  feeApr: {
    id: "feeApr",
    title: "Fee APR",
    short: "Какая годовая доходность от комиссий",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          APR (Annual Percentage Rate) = годовая ставка. Показывает сколько
          бы вы заработали в год если доходность сохранится.
        </p>
        <p>
          <strong className="text-foreground">Простой пример:</strong>{" "}
          позиция работает 30 дней, заработали $50 на капитале $1,000. Если
          бы такой темп продолжался весь год:
        </p>
        <p className="rounded bg-secondary/40 px-2 py-1.5 font-mono text-xs">
          $50 × (365 / 30) = $608 в год
          <br />
          $608 / $1,000 = <strong>60.8% годовых</strong>
        </p>
        <p>
          ⚠️ Это{" "}
          <strong className="text-foreground">проекция, не гарантия</strong>
          — реальная доходность может отличаться. Чем дольше работает
          позиция (чем больше «срок» в днях), тем точнее цифра.
        </p>
      </div>
    ),
  },
  totalAssets: {
    id: "totalAssets",
    title: "Итого активы",
    short: "Полная сумма всех ваших денег связанных с позицией",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          <strong className="text-foreground">
            Текущая $ + накопленные комиссии (pending + claimed)
          </strong>
        </p>
        <p>
          Самая полная цифра «сколько у меня связано с этой позицией».
          Включает и стоимость самих токенов, и заработанные но не
          забранные комиссии.
        </p>
        <p>
          <strong className="text-foreground">Пример:</strong> позиция
          стоит $11,500 + накопилось $50 комиссий = $11,550 в сумме.
        </p>
        <p>
          Для лендинга = Текущая $ (комиссии уже включены в количество
          токенов, не складываем дважды).
        </p>
      </div>
    ),
  },
  totalPnl: {
    id: "totalPnl",
    title: "Total PnL",
    short: "Главная цифра — заработали ли вы на позиции в итоге",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          <strong className="text-foreground">
            Итого активы − Стартовая $
          </strong>{" "}
          — самая важная метрика.
        </p>
        <p>Объединяет два источника результата:</p>
        <ul className="ml-4 list-disc space-y-0.5">
          <li>Изменение цены ваших токенов (PnL позиций)</li>
          <li>Заработанные комиссии и проценты (Fee)</li>
        </ul>
        <p>
          <strong className="text-foreground">Пример:</strong> положили
          $10,000. Сейчас стоит $11,500 (+$1,500 от роста цены) + $50
          комиссий = +$1,550. Это и есть Total PnL.
        </p>
        <p>
          Зелёное число — заработали. Красное — потеряли. Процент рядом —
          какой это процент от стартовой суммы.
        </p>
      </div>
    ),
  },
  totalApr: {
    id: "totalApr",
    title: "Total APR",
    short: "Полная годовая доходность позиции",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          То же что Fee APR, но для полного результата (Total PnL): и от
          цены, и от комиссий вместе.
        </p>
        <p>
          <strong className="text-foreground">Пример:</strong> позиция
          работает 60 дней, заработали $200 на капитале $1,000.
        </p>
        <p className="rounded bg-secondary/40 px-2 py-1.5 font-mono text-xs">
          $200 × (365 / 60) = $1,217 в год
          <br />
          $1,217 / $1,000 = <strong>121.7% годовых</strong>
        </p>
        <p>
          ⚠️ Цифра волатильна — если завтра цена ETH упадёт, Total APR
          сразу станет хуже. Это{" "}
          <strong className="text-foreground">текущая «температура»</strong>
          , а не реальный годовой результат.
        </p>
      </div>
    ),
  },
  weight: {
    id: "weight",
    title: "Вес %",
    short: "Какую долю позиция занимает в вашем общем портфеле",
    detailed: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Сколько процентов от всех ваших открытых позиций приходится на
          эту.
        </p>
        <p>
          <strong className="text-foreground">Пример:</strong> у вас всего
          в DeFi $100,000. В этой позиции $30,000 → Вес = 30%.
        </p>
        <p>
          Зачем смотреть:{" "}
          <strong className="text-foreground">диверсификация</strong>. Если
          одна позиция занимает 50% — это рискованно (если она провалится,
          половина портфеля пострадает). Здоровый портфель имеет много
          позиций по 5-15%.
        </p>
      </div>
    ),
  },
};

export interface ColumnHelpDialogProps {
  open: boolean;
  onClose: () => void;
  columnId: string | null;
}

export function ColumnHelpDialog({
  open,
  onClose,
  columnId,
}: ColumnHelpDialogProps) {
  const help = columnId ? COLUMN_HELPS[columnId] : null;
  if (!help) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={
        <div className="flex flex-col gap-0.5">
          <span className="text-sm">📖 {help.title}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {help.short}
          </span>
        </div>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto py-1">{help.detailed}</div>
    </Dialog>
  );
}

export function hasColumnHelp(columnId: string): boolean {
  return columnId in COLUMN_HELPS;
}
