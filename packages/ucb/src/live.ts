/**
 * Чейн-нейтральные типы для live-state: «что у меня есть прямо сейчас».
 * Заполняются и из DeBank (EVM), и из Helius+Jupiter (Solana).
 */

export interface LiveTokenBalance {
  symbol: string;
  /** mint (Solana) или contract id (EVM). */
  tokenId: string;
  chain: string;            // "eth" | "arb" | … | "sol"
  amount: number;
  price: number | null;
  usd: number;              // amount × price (0, если price нет)
  walletId: string;
  walletName: string;
  isStable: boolean;
  /** Логотип (если знаем). */
  logo?: string | null;
  /**
   * Известен ли токен нашему реестру (или DeBank/Helius верифицировали его).
   * Помогает фильтровать airdrop-спам ("GM", "claim X", и пр.).
   */
  isKnown: boolean;
  /** Cost basis (по средневзвешенной из истории операций). */
  costBasisUsd?: number;
  costBasisAvg?: number;
  /** PnL = currentUsd − costBasisUsd. */
  pnlUsd?: number;
  pnlPct?: number;
}

export interface LivePositionTokenLine {
  symbol: string;
  amount: number;
  usd: number;
  /** Контракт-адрес/mint токена. Нужен для матчинга live-позиции с историей
   *  по mint'у LP-receipt'а в мульти-маркетных протоколах (GMX V2: GM[BTC]
   *  vs GM[ETH] vs GLV[WETH-USDC]). Заполняется адаптером DeBank/Vybe из
   *  `id` соответствующего токена. */
  tokenId?: string;
  /**
   * Признак стейбла — заполняется live-адаптером (DeBank/Vybe). Optional;
   * `open_positions` читает его как hint при cost-basis расчёте.
   * (A0: surfaced when the engine moved to a strict-typechecked package.)
   */
  isStable?: boolean;
}

export interface LiveProtocolPosition {
  protocolId: string;
  protocolName: string;
  protocolLogo?: string | null;
  chain: string;
  walletId: string;
  walletName: string;
  /** "lending" | "lp" | "staking" | "vault" | "yield" | "restaking" | "perp" | …  */
  category: string;
  /** "Lending" / "Liquidity Pool" / "Vault" / "Staking" — человекочитаемый. */
  itemName: string;
  netUsd: number;
  assetUsd: number;
  debtUsd: number;
  healthRate?: number | null;
  supply: LivePositionTokenLine[];
  borrow: LivePositionTokenLine[];
  rewards: LivePositionTokenLine[];
  /**
   * Идентификатор маркета/пула для уникализации позиций когда в одном
   * протоколе+сети их несколько (GMX V2: GM[BTC]/GM[ETH]/GLV[WETH-USDC]).
   * Источники:
   *   - DeBank: `item.pool?.id` или `item.detail.token?.id` (контракт LP-receipt'а).
   *   - Vybe / Jupiter Portfolio: их internal id (если есть).
   * Этот идентификатор затем матчится с `linkedLpTokenId` в ops, чтобы
   * `findFirstOpen` / `currentCycleDepositForSymbol` фильтровали историю
   * только по этому конкретному маркету.
   */
  lpTokenId?: string;
}

export interface LiveSnapshot {
  totalUsd: number;
  tokens: LiveTokenBalance[];
  positions: LiveProtocolPosition[];
  /** Источники, использованные при построении снимка (для UI диагностики). */
  sources?: LiveSourceStatus[];
}

/**
 * Возвращает список «непрайсованных» активов — те, у кого amount > 0,
 * но рыночной цены нет (`price === null`). Эти токены НЕ входят в
 * `totalUsd` снимка (их usd=0), и UI должен показывать их отдельно,
 * чтобы пользователь не считал, что Capflow «потерял» эти активы.
 *
 * Типичные случаи:
 *  - синтетические токены протоколов (GMTrade GM/GLV)
 *  - jupiter vault NFT-receipts
 *  - нишевые токены без листинга на DEX (Pyth/Birdeye/Jupiter Price их не знают)
 */
export function listUnpricedTokens(snap: LiveSnapshot): LiveTokenBalance[] {
  return snap.tokens.filter(
    (t) => (t.price === null || t.price === 0) && t.amount > 0,
  );
}

/** Сводка по непрайсованным: сколько токенов и сумма cost basis (если есть). */
export function summarizeUnpriced(snap: LiveSnapshot): {
  count: number;
  knownCostBasisUsd: number;
} {
  const list = listUnpricedTokens(snap);
  const knownCostBasisUsd = list.reduce(
    (s, t) => s + (t.costBasisUsd ?? 0),
    0,
  );
  return { count: list.length, knownCostBasisUsd };
}

export interface LiveSourceStatus {
  name: string;            // "DeBank" | "Helius" | "Jupiter Price" | "Vybe Network" | "SonarWatch"
  ok: boolean;
  positions?: number;
  tokens?: number;
  error?: string | undefined;
}
