/**
 * DefiLlama Protocols catalog — авто-классификация любого DeFi-протокола.
 *
 * **Решает проблему scaling whitelist'а**: вместо hardcoded
 * `RECEIPT_CONTRACTS` / `kindFromCategory` для каждого нового протокола,
 * используем DefiLlama's curated database of ~5000 protocols.
 *
 * Endpoint: `https://api.llama.fi/protocols` (free, no auth)
 *
 * Из каждого protocol record нам нужны:
 *   - `name`, `slug` — для матчинга с DeBank protocol_id
 *   - `category` — "Lending", "Liquid Staking", "Dexes", "Yield",
 *     "CDP", "Cross Chain", "Staking Pool", и т.д.
 *   - `chains` — список chains, поддерживаемых протоколом
 *   - `module` — internal slug для drill-down `/protocol/{slug}`
 *
 * Кэш: localStorage `capflow.cache.llama_protocols.v1` — 24h.
 *
 * Использование в коде:
 *   const proto = await lookupDefiLlamaProtocol("morphoblue", "arb");
 *   const kind = mapDefiLlamaCategory(proto.category); // → "lending"
 */

const PROXY = "/llamaprotos";
const CACHE_KEY = "capflow.cache.llama_protocols.v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface LlamaProtocol {
  id: string;
  name: string;
  symbol?: string;
  slug?: string;
  category?: string;
  chain?: string;
  chains?: string[];
  url?: string;
  logo?: string;
  description?: string;
  module?: string;
}

interface CacheShape {
  fetchedAt: number;
  protocols: LlamaProtocol[];
}

let inMemory: LlamaProtocol[] | null = null;
let inflightPromise: Promise<LlamaProtocol[]> | null = null;

/**
 * Загрузить (или вернуть кэш) полный каталог протоколов DefiLlama.
 * Singleton: первый вызов делает fetch, остальные возвращают тот же promise.
 */
export async function loadLlamaProtocols(): Promise<LlamaProtocol[]> {
  if (inMemory) return inMemory;
  if (inflightPromise) return inflightPromise;
  // Пробуем кэш.
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CacheShape;
      if (
        parsed.fetchedAt &&
        Date.now() - parsed.fetchedAt < CACHE_TTL_MS &&
        Array.isArray(parsed.protocols)
      ) {
        inMemory = parsed.protocols;
        return inMemory;
      }
    }
  } catch {
    /* ignore */
  }
  inflightPromise = (async () => {
    try {
      const res = await fetch(`${PROXY}/protocols`);
      if (!res.ok) throw new Error(`DefiLlama protocols fetch failed: ${res.status}`);
      const data = (await res.json()) as LlamaProtocol[];
      inMemory = data;
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ fetchedAt: Date.now(), protocols: data }),
        );
      } catch {
        /* localStorage quota — игнорируем */
      }
      return data;
    } catch (e) {
      console.warn("[defillama_protocols] load failed:", e);
      return [];
    } finally {
      inflightPromise = null;
    }
  })();
  return inflightPromise;
}

/**
 * Найти DefiLlama protocol по DeBank protocol_id или name.
 *
 * Стратегии (в порядке приоритета):
 *   1. Точное совпадение DeBank id с DefiLlama slug
 *   2. Substring match по slug (`arb_morphoblue` → `morpho-blue`)
 *   3. Fuzzy match по name
 */
export function lookupProtocol(
  protocols: readonly LlamaProtocol[],
  protocolId: string,
  protocolName?: string,
): LlamaProtocol | null {
  if (!protocolId && !protocolName) return null;
  const id = protocolId.toLowerCase();
  const name = (protocolName ?? "").toLowerCase();

  // Strip chain prefix: "arb_morphoblue" → "morphoblue"
  const idStripped = id.replace(/^[a-z]+_/, "");

  // 1. Slug exact match.
  for (const p of protocols) {
    if (p.slug && p.slug.toLowerCase() === idStripped) return p;
    if (p.slug && p.slug.toLowerCase() === id) return p;
  }
  // 2. Slug substring match (handle "morphoblue" → "morpho-blue").
  const idNoSep = idStripped.replace(/[-_]/g, "");
  for (const p of protocols) {
    if (!p.slug) continue;
    const slugNoSep = p.slug.toLowerCase().replace(/[-_]/g, "");
    if (slugNoSep === idNoSep) return p;
    if (slugNoSep.includes(idNoSep) && idNoSep.length > 4) return p;
  }
  // 3. Module match.
  for (const p of protocols) {
    if (p.module && p.module.toLowerCase() === idStripped) return p;
  }
  // 4. Name fuzzy match.
  if (name) {
    for (const p of protocols) {
      if (p.name.toLowerCase() === name) return p;
    }
    for (const p of protocols) {
      const pname = p.name.toLowerCase();
      if (pname.includes(name) || name.includes(pname.slice(0, 5))) return p;
    }
  }
  return null;
}

/**
 * Map DefiLlama category → наш `ProtocolCategory` (используется в
 * `classifyProtocol` для решения, какой ветке classifier'а отдать op).
 *
 * Это отличается от `mapDefiLlamaCategory` (которая возвращает PositionKind):
 * здесь нам нужна точнее различимая category, потому что classifier
 * выбирает ветку по ней (dex/lending/staking/restaking/perp/yield/bridge/cdp).
 */
export function mapDefiLlamaToProtocolCategory(
  category: string | undefined | null,
):
  | "lending"
  | "dex"
  | "lp"
  | "staking"
  | "restaking"
  | "yield"
  | "perp"
  | "bridge"
  | "cdp"
  | "other" {
  if (!category) return "other";
  const c = category.toLowerCase();
  // Order matters — more specific first.
  if (c.includes("cdp")) return "cdp";
  if (c.includes("liquid restak") || c.includes("restak")) return "restaking";
  if (c.includes("liquid stak") || c === "staking pool" || c.includes("stak"))
    return "staking";
  if (c.includes("bridge") || c.includes("cross chain")) return "bridge";
  if (c.includes("derivativ") || c.includes("perp") || c.includes("option"))
    return "perp";
  if (
    c.includes("dex") ||
    c.includes("amm") ||
    c.includes("liquidity manager") ||
    c.includes("dex aggregator")
  )
    return "dex";
  if (
    c.includes("lend") ||
    c.includes("rwa lending") ||
    c.includes("borrow")
  )
    return "lending";
  if (
    c.includes("yield") ||
    c.includes("farm") ||
    c.includes("vault") ||
    c.includes("indexes")
  )
    return "yield";
  return "other";
}

/**
 * Map DefiLlama category → наш PositionKind.
 *
 * DefiLlama categories include:
 *   - Lending, CDP, Liquid Staking, Staking Pool, Liquid Restaking
 *   - Dexes, Yield, Yield Aggregator
 *   - Derivatives, Options, Prediction Market
 *   - Bridge, RWA, Insurance, Synthetics
 */
export function mapDefiLlamaCategory(
  category: string | undefined | null,
): "lending" | "lp" | "staking" | "perp" | "other" {
  if (!category) return "other";
  const c = category.toLowerCase();
  if (
    c.includes("lend") ||
    c.includes("cdp") ||
    c.includes("borrow") ||
    c.includes("rwa lending")
  )
    return "lending";
  if (
    c.includes("dex") ||
    c.includes("yield") ||
    c.includes("liquidity") ||
    c.includes("vault") ||
    c.includes("farm") ||
    c.includes("amm")
  )
    return "lp";
  if (c.includes("stak") || c.includes("restak")) return "staking";
  if (
    c.includes("derivativ") ||
    c.includes("perp") ||
    c.includes("option")
  )
    return "perp";
  return "other";
}

/**
 * Опеределить является ли протокол **receipt-less** на основе DefiLlama
 * category. Receipt-less = не выдаёт receipt-token в кошелёк (lending
 * через explicit market like Morpho Blue, Drift Spot, Adrena pools).
 *
 * Эвристика: lending без явного receipt-token (CDP протоколы и Morpho-style
 * isolated markets часто receipt-less). Точная детекция требует drill-down
 * /protocol/{slug} но эвристика работает в 80% случаев.
 */
export function isLikelyReceiptLess(
  category: string | undefined | null,
  protocolName?: string,
): boolean {
  const name = (protocolName ?? "").toLowerCase();
  // Known receipt-less protocols (manual whitelist для надёжности).
  if (name.includes("morpho")) return true;
  if (name.includes("drift")) return true;
  if (name.includes("adrena")) return true;
  if (name.includes("euler v2")) return true; // Euler v2 isolated vaults
  // Эвристика по категории.
  const c = (category ?? "").toLowerCase();
  if (c === "cdp") return true; // CDP protocols (Liquity, MakerDAO style) часто receipt-less для debt
  return false;
}

/** Полная характеристика протокола для использования в коде. */
export interface ProtocolMetadata {
  source: "defillama" | "fallback";
  llama: LlamaProtocol | null;
  kind: "lending" | "lp" | "staking" | "perp" | "other";
  isReceiptLess: boolean;
}

/**
 * Главная entry-point функция — получить метаданные для DeBank protocol_id.
 * Сама загружает каталог (если нужно), кэширует в memory.
 */
export async function getProtocolMetadata(
  protocolId: string,
  protocolName?: string,
): Promise<ProtocolMetadata> {
  const protocols = await loadLlamaProtocols();
  const llama = lookupProtocol(protocols, protocolId, protocolName);
  if (!llama) {
    return {
      source: "fallback",
      llama: null,
      kind: "other",
      isReceiptLess: false,
    };
  }
  return {
    source: "defillama",
    llama,
    kind: mapDefiLlamaCategory(llama.category),
    isReceiptLess: isLikelyReceiptLess(llama.category, llama.name),
  };
}

/**
 * Synchronous lookup из уже загруженного memory кэша. Для использования
 * внутри pure-функций где async не подходит. Возвращает null если каталог
 * не загружен — вызывающий код должен fallback на старый whitelist.
 */
export function getProtocolMetadataSync(
  protocolId: string,
  protocolName?: string,
): ProtocolMetadata | null {
  if (!inMemory) return null;
  const llama = lookupProtocol(inMemory, protocolId, protocolName);
  if (!llama) {
    return {
      source: "fallback",
      llama: null,
      kind: "other",
      isReceiptLess: false,
    };
  }
  return {
    source: "defillama",
    llama,
    kind: mapDefiLlamaCategory(llama.category),
    isReceiptLess: isLikelyReceiptLess(llama.category, llama.name),
  };
}
