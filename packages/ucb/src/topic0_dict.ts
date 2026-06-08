/**
 * Событийный словарь `event topic0 → op_type` — фундамент топик0-лестницы
 * классификатора (план `notes/decisions/classifier-upgrade-plan.md`, словарь
 * `topic0-op-dictionary.md`). topic0 = keccak256 ABI-подписи события = ground
 * truth самого блокчейна (протокол-агностично, не зависит от интерпретации
 * DeBank). Это ЧИСТЫЙ слой: словарь + `classifyByTopic0` + `detectDataDecodeFamily`.
 * Вживление (log-fetch enrichment + вставка ступенью 1 в doClassify со shadow-diff)
 * — отдельный шаг. Пока никем не вызывается → ноль регресса.
 *
 * Хэши выверены on-chain (Alchemy RPC, ETH/Arb, 2026-06-04). Коллизии (один
 * topic0 → разный смысл) резолвятся по категории emitting-протокола.
 */
import type { OpType, ProtocolCategory } from "./types.js";

export interface Topic0Log {
  /** Адрес emitting-контракта (lowercase) — для резолва коллизий. Опционален. */
  readonly address?: string;
  /** topic0 события (lowercase). */
  readonly topic0: string;
  /** Non-indexed данные лога (hex "0x…") — для DATA-decode (знак/amount). Опц. */
  readonly data?: string;
}

export interface Topic0Entry {
  readonly opType: OpType;
  readonly event: string;
  /**
   * Коллизия: тот же topic0 → разный op_type в зависимости от категории
   * emitting-протокола (напр. Mint 0x4c209b5f = UniV2 lp_add ИЛИ Compound v2
   * cToken lend_supply). Если ctx.protocolCategory задан и есть в map —
   * используется он; иначе fallback на `opType`.
   */
  readonly byCategory?: Partial<Record<ProtocolCategory, OpType>>;
  /**
   * DATA-decode: op_type зависит от данных лога (знак int256 / amount). Если
   * задан — используется вместо статического opType/byCategory. Возвращает null
   * когда data недоступна/неоднозначна → событие пропускается (не гадаем).
   */
  readonly decode?: (log: Topic0Log) => OpType | null;
}

/** k-е 32-байтовое слово non-indexed data лога как uint, либо null. */
function wordAt(data: string | undefined, i: number): bigint | null {
  if (!data || !data.startsWith("0x")) return null;
  const hex = data.slice(2);
  const start = i * 64;
  if (hex.length < start + 64) return null;
  try {
    return BigInt("0x" + hex.slice(start, start + 64));
  } catch {
    return null;
  }
}
/** uint256 → int256 (two's complement). */
function asInt256(u: bigint): bigint {
  return u >= 1n << 255n ? u - (1n << 256n) : u;
}

/** Семейства, где op_type/направление закодированы в DATA лога, не в topic0. */
export type DataDecodeFamily = "gmx" | "fluid" | "univ4" | "pendle";

/** Низкий хэш = низкий приоритет при выборе главного события tx. */
const RANK: Partial<Record<OpType, number>> = {
  lp_add: 3,
  lp_remove: 3,
  lend_supply: 3,
  lend_withdraw: 3,
  borrow: 3,
  repay: 3,
  stake: 3,
  unstake: 3,
  claim_rewards: 2,
  swap: 2,
};

/** ERC20 Transfer / Approval — контекст, не действие. Скипаем при сканировании. */
export const NOISE_TOPIC0 = new Set<string>([
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", // Approval
]);

/**
 * EventEmitter-сигнатуры семейств, требующих DATA-decode (имя/знак внутри data).
 * topic0 распознаёт семейство, но op_type даёт только декодер семейства.
 */
export const DATA_DECODE_TOPIC0 = new Map<string, DataDecodeFamily>([
  // GMX V2 / Fluid EventEmitter-семейства — topic0 усечены в словаре, полные
  // хэши выверить on-chain при реализации декодеров (TODO):
  //   GMX EventLog1/EventLog2, Fluid LogOperate-family.
  // (UniV4 ModifyLiquidity перенесён в TOPIC0_DICT с inline-decode по знаку.)
]);

/** topic0 (lowercase) → запись. Выверенные сигнатуры (см. topic0-op-dictionary.md). */
export const TOPIC0_DICT = new Map<string, Topic0Entry>([
  // ── Tier 1 — универсальные ERC ──
  ["0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7", { opType: "lend_supply", event: "ERC4626 Deposit", byCategory: { lp: "lp_add", dex: "lp_add" } }],
  ["0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db", { opType: "lend_withdraw", event: "ERC4626 Withdraw" }],

  // ── Uniswap V2 family (Sushi/Pancake V2, Aero/Velo volatile) ──
  // ⚠ коллизия с Compound v2 cToken Mint → резолв по категории.
  ["0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f", { opType: "lp_add", event: "UniV2 Mint / cToken Mint", byCategory: { lending: "lend_supply", cdp: "lend_supply" } }],
  ["0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496", { opType: "lp_remove", event: "UniV2 Burn" }],
  ["0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", { opType: "swap", event: "UniV2 Swap" }],

  // ── Uniswap V3 — NonfungiblePositionManager (+ Pancake/Sushi V3, Krystal) ──
  ["0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f", { opType: "lp_add", event: "V3 IncreaseLiquidity" }],
  ["0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4", { opType: "lp_remove", event: "V3 DecreaseLiquidity" }],
  ["0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01", { opType: "claim_rewards", event: "V3 NPM Collect (LP fee)" }],
  // ── Uniswap V3 — pool-level ──
  ["0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde", { opType: "lp_add", event: "V3 pool Mint" }],
  // V3 pool Burn: amount=0 (data word0) = decreaseLiquidity(0) для сбора fee →
  // claim_rewards, иначе реальное уменьшение → lp_remove. Без data → lp_remove.
  ["0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c", {
    opType: "lp_remove",
    event: "V3 pool Burn",
    decode: (log) => {
      const amount = wordAt(log.data, 0); // uint128 amount
      if (amount == null) return "lp_remove";
      return amount === 0n ? "claim_rewards" : "lp_remove";
    },
  }],
  ["0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0", { opType: "claim_rewards", event: "V3 pool Collect (fee)" }],
  ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", { opType: "swap", event: "V3 pool Swap" }],

  // ── Uniswap V4 — singleton ──
  ["0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", { opType: "swap", event: "V4 Swap" }],
  // V4 ModifyLiquidity: add vs remove = знак int256 liquidityDelta (data word2:
  // tickLower,tickUpper,liquidityDelta,salt). >0 add, <0 remove, 0/нет data → skip.
  ["0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec", {
    opType: "lp_add",
    event: "V4 ModifyLiquidity",
    decode: (log) => {
      const w = wordAt(log.data, 2); // liquidityDelta
      if (w == null) return null;
      const d = asInt256(w);
      return d > 0n ? "lp_add" : d < 0n ? "lp_remove" : null;
    },
  }],

  // ── Aave V2 (LendingPool) ──
  ["0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951", { opType: "lend_supply", event: "Aave V2 Deposit" }],
  ["0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7", { opType: "lend_withdraw", event: "Aave V2/V3 Withdraw" }],
  ["0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b", { opType: "borrow", event: "Aave V2 Borrow" }],
  ["0x4cdde6e09bb755c9a5589ebaec640bbfedff1362d4b255ebf8339782b9942faa", { opType: "repay", event: "Aave V2 Repay" }],
  // ── Aave V3 (Pool) ──
  ["0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61", { opType: "lend_supply", event: "Aave V3 Supply" }],
  ["0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0", { opType: "borrow", event: "Aave V3 Borrow" }],
  ["0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051", { opType: "repay", event: "Aave V3 Repay" }],

  // ── Compound v2 (cToken) ── (Mint коллизия выше)
  ["0xe5b754fb1abb7f01b499791d0b820ae3b6af3424ac1c59768edb53f4ec31a929", { opType: "lend_withdraw", event: "cToken Redeem" }],
  ["0x13ed6866d4e1ee6da46f845c46d7e54120883d75c5ea9a2dacc1c4ca8984ab80", { opType: "borrow", event: "cToken Borrow" }],
  ["0x1a2a22cb034d26d1854bdc6666a5b91fe25efbbb5dcad3b0355478d6f5c362a1", { opType: "repay", event: "cToken RepayBorrow" }],
  // ── Compound v3 (Comet) ──
  ["0xd1cf3d156d5f8f0d50f6c122ed609cec09d35c9b9fb3fff6ea0959134dae424e", { opType: "lend_supply", event: "Comet Supply" }],
  ["0x9b1bfa7fa9ee420a16e124f794c35ac9f90472acc99140eb2f6447c714cad8eb", { opType: "lend_withdraw", event: "Comet Withdraw" }],
  ["0xfa56f7b24f17183d81894d3ac2ee654e3c26388d17a28dbd9549b8114304e1f4", { opType: "lend_supply", event: "Comet SupplyCollateral" }],
  ["0xd6d480d5b3068db003533b170d67561494d72e3bf9fa40a266471351ebba9e16", { opType: "lend_withdraw", event: "Comet WithdrawCollateral" }],

  // ── Curve (topic0 по arity coins) ──
  ["0x423f6495a08fc652425cf4ed0d1f9e37e571d9b9529b1c1c23cce780b2e7df0d", { opType: "lp_add", event: "Curve AddLiquidity (3)" }],
  ["0x26f55a85081d24974e85c6c00045d0f0453991e95873f52bff0d21af4079a768", { opType: "lp_add", event: "Curve AddLiquidity (2)" }],
  ["0xa49d4cf02656aebf8c771f5a8585638a2a15ee6c97cf7205d4208ed7c1df252d", { opType: "lp_remove", event: "Curve RemoveLiquidity (3)" }],
  ["0x7c363854ccf79623411f8995b362bce5eddff18c927edc6f5dbbb5e05819a82c", { opType: "lp_remove", event: "Curve RemoveLiquidity (2)" }],
  ["0x5ad056f2e28a8cec232015406b843668c1e36cda598127ec3b8c59b8c72773a0", { opType: "lp_remove", event: "Curve RemoveLiquidityOne" }],
  ["0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140", { opType: "swap", event: "Curve TokenExchange" }],

  // ── Convex ──
  ["0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca", { opType: "stake", event: "Convex Booster Deposited" }],
  ["0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6", { opType: "unstake", event: "Convex Booster Withdrawn" }],

  // ── Synthetix StakingRewards / Convex BaseRewardPool / Curve gauges ──
  // (Staked/Withdrawn общие с Convex BaseRewardPool — оба одинаковы, безопасно)
  ["0x9e71bc8eea02a63969f509818f2dafb9254532904319f9dbda79b67bd34a5f3d", { opType: "stake", event: "StakingRewards Staked" }],
  ["0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5", { opType: "unstake", event: "StakingRewards Withdrawn" }],
  ["0xe2403640ba68fed3a2f88b7557551d1993f84b99bb10ff833f0cf8db0c5e0486", { opType: "claim_rewards", event: "StakingRewards RewardPaid" }],

  // ── Lido / ether.fi ──
  ["0x96a25c8ce0baabc1fdefd93e9ed25d8e092a3332f3aa9a41722b5697231d1d1a", { opType: "stake", event: "Lido Submitted" }],
  ["0xa241faf62e66ce518d1934ce4c936d806a02289ba483fac23beb8c15755be90d", { opType: "stake", event: "ether.fi LP Deposit (mint eETH)" }],

  // ── Morpho Blue (singleton) ──
  ["0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0", { opType: "lend_supply", event: "Morpho Supply" }],
  ["0xa56fc0ad5702ec05ce63666221f796fb62437c32db1aa1aa075fc6484cf58fbf", { opType: "lend_withdraw", event: "Morpho Withdraw" }],
  ["0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43", { opType: "borrow", event: "Morpho Borrow" }],
  ["0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09", { opType: "repay", event: "Morpho Repay" }],
  ["0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184", { opType: "lend_supply", event: "Morpho SupplyCollateral" }],
  ["0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142", { opType: "lend_withdraw", event: "Morpho WithdrawCollateral" }],
]);

export interface Topic0Result {
  readonly opType: OpType;
  readonly matchedTopic0: string;
  readonly event: string;
}

export interface ClassifyByTopic0Ctx {
  /** Категория протокола op'а — для резолва коллизий (Mint UniV2 vs cToken). */
  readonly protocolCategory?: ProtocolCategory | null;
}

function rankOf(op: OpType): number {
  return RANK[op] ?? 0;
}

/**
 * Главное действие tx по логам: берём событие из словаря с наивысшим рангом
 * (position-defining > claim/swap). Шум (Transfer/Approval) и data-decode-семейства
 * пропускаем. Коллизии резолвим по `ctx.protocolCategory`.
 *
 * Возвращает null, когда: словарных совпадений нет, ИЛИ найдены только
 * шум/data-decode события (caller сам решает — fallback на fnName/движение или
 * запуск декодера семейства). Чистая, детерминированная.
 *
 * ⚠ Ограничение: при нескольких равноранговых position-событиях в одной tx
 * (мульти-action wrapper) выбирается первое по порядку логов. Точное разделение
 * требует реального log_index (сейчас хардкод 0) — отдельный пункт плана.
 */
export function classifyByTopic0(
  logs: readonly Topic0Log[],
  ctx: ClassifyByTopic0Ctx = {},
): Topic0Result | null {
  let best: Topic0Result | null = null;
  let bestRank = -1;
  for (const log of logs) {
    const t = log.topic0?.toLowerCase();
    if (!t || NOISE_TOPIC0.has(t)) continue;
    if (DATA_DECODE_TOPIC0.has(t)) continue; // EventEmitter-семейство → внешний декодер (GMX/Fluid)
    const entry = TOPIC0_DICT.get(t);
    if (!entry) continue;
    // entry.decode (V4 знак / V3 Burn amount) авторитетнее статики; null → skip.
    const opType = entry.decode
      ? entry.decode(log)
      : (ctx.protocolCategory && entry.byCategory?.[ctx.protocolCategory]) ||
        entry.opType;
    if (!opType) continue;
    const r = rankOf(opType);
    if (r > bestRank) {
      bestRank = r;
      best = { opType, matchedTopic0: t, event: entry.event };
    }
  }
  // Context-aware подавление свопа: на POSITION-протоколе (yield/lp/lending/…)
  // единственное распознанное событие = swap почти всегда ВНУТРЕННИЙ своп
  // аггрегатора/vault'а (Curve/V4 внутри депозита), не действие юзера. Не
  // доверяем topic0 → null (DeBank-ладдер сохранит свой lp_add/lend_supply).
  // Фикс аггрегатор-запов (Alice lp_add→swap). Genuine swap (cat=dex/null) — ок.
  if (
    best &&
    best.opType === "swap" &&
    ctx.protocolCategory &&
    POSITION_CATEGORIES.has(ctx.protocolCategory)
  ) {
    return null;
  }
  return best;
}

/** Position-протоколы: на них topic0-swap трактуем как внутренний (не доверяем). */
const POSITION_CATEGORIES = new Set<ProtocolCategory>([
  "lending",
  "lp",
  "staking",
  "restaking",
  "yield",
  "cdp",
]);

/**
 * Распознать DATA-decode семейство по логам (GMX/Fluid/UniV4/Pendle) — op_type
 * этих семейств кодируется в DATA лога, не в topic0. Возвращает семейство для
 * запуска соответствующего декодера (шаг вживления), либо null.
 */
export function detectDataDecodeFamily(
  logs: readonly Topic0Log[],
): DataDecodeFamily | null {
  for (const log of logs) {
    const t = log.topic0?.toLowerCase();
    if (!t) continue;
    const fam = DATA_DECODE_TOPIC0.get(t);
    if (fam) return fam;
  }
  return null;
}
