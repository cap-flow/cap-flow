/**
 * Upstream-proxy address-ownership guard (S3 security hardening).
 *
 * Without this guard the upstream-proxy is an IDOR: any authenticated
 * user can pass an arbitrary blockchain address through DeBank / Helius
 * / Etherscan / Alchemy and the request is forwarded with the admin's
 * paid API key. That lets anyone (a) scan any wallet's portfolio at our
 * expense, (b) silently drain admin's per-day quotas with directory-
 * style scraping.
 *
 * Policy implemented here:
 *   1. Identify every blockchain address present in the proxied
 *      request (path, query, body) for the given provider.
 *   2. Each address must be owned by the calling user OR caller must
 *      be admin. Otherwise → 403.
 *   3. Malformed addresses (right slot, wrong format) → 400 so the
 *      frontend doesn't keep retrying.
 *   4. Endpoints with NO extractable address (e.g. provider-status
 *      endpoints) pass through unchanged. The allow-list in
 *      upstream-proxy.service.ts already keeps the path surface tight.
 *
 * EVM addresses are normalised to lowercase. Solana addresses are
 * case-sensitive but checksum-free, compared verbatim. The user's
 * address set is computed once per request (in-request memoize) so
 * a chained call doesn't hit the DB on every hop.
 *
 * Per-provider address-location table (the audit doc lives in
 * notes/decisions/security-hardening-pre-prod.md, kept in sync with
 * the extractor below):
 *
 *  DeBank        : query.id, query.user_addr, query.addr,
 *                  query.addresses (CSV)
 *  Helius        : path segment after "v0/addresses/" or
 *                  "v0/token-metadata" (no addr), body.accounts[]
 *                  on POSTs to /v0/transactions
 *  Etherscan v2  : query.address (single or CSV for balancemulti)
 *  Alchemy       : body.params[0] for most JSON-RPC methods; for
 *                  alchemy_getAssetTransfers, body.params[0].fromAddress
 *                  and body.params[0].toAddress; batch arrays handled.
 */

const EVM_HEX = /^0x[a-fA-F0-9]{40}$/;
// SOL base58 (32–44 chars, no 0,O,I,l). Used only as a sanity check;
// we still defer to the actual ownership set, so accidental matches
// against valid-looking strings (e.g. a memo) only cost a lookup.
const SOL_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type AddressKind = "evm" | "solana" | "unknown";

export interface ExtractedAddress {
  readonly raw: string;
  /** Canonical form: EVM → lowercased, Solana/other → unchanged. */
  readonly normalized: string;
  readonly kind: AddressKind;
  /** Human-readable trace of where the address was found (for 400/403 msg). */
  readonly source: string;
}

export interface ProxyRequestForGuard {
  readonly provider: string;
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
}

function normalize(raw: string): ExtractedAddress | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (EVM_HEX.test(trimmed)) {
    return {
      raw: trimmed,
      normalized: trimmed.toLowerCase(),
      kind: "evm",
      source: "",
    };
  }
  if (SOL_BASE58.test(trimmed)) {
    return { raw: trimmed, normalized: trimmed, kind: "solana", source: "" };
  }
  return null;
}

function pushFromAny(
  out: ExtractedAddress[],
  invalid: string[],
  raw: unknown,
  source: string
): void {
  if (raw == null) return;
  // CSV / array.
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      pushFromAny(out, invalid, raw[i], `${source}[${i}]`);
    }
    return;
  }
  if (typeof raw === "string") {
    // Split on comma to handle Etherscan's `balancemulti` CSV input.
    const parts = raw.includes(",") ? raw.split(",") : [raw];
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i]!.trim();
      if (!piece) continue;
      const n = normalize(piece);
      if (n) {
        out.push({ ...n, source: parts.length > 1 ? `${source}[${i}]` : source });
      } else if (looksLikeAddrAttempt(piece)) {
        // String in an address slot that fails both EVM and Solana regex
        // → malformed. We track it so the route can return 400 instead
        // of silently passing it through.
        invalid.push(`${source}: ${piece.slice(0, 80)}`);
      }
    }
    return;
  }
  // Numbers/booleans in an address slot → invalid.
  if (typeof raw === "number" || typeof raw === "boolean") {
    invalid.push(`${source}: ${String(raw)}`);
  }
}

function looksLikeAddrAttempt(s: string): boolean {
  // Reject things that obviously aren't an address attempt (tx hashes,
  // chain ids, ENS names, signatures). The point is: if a slot is
  // *supposed* to carry an address and the value is hex-ish but wrong
  // length / non-hex chars, that's malformed. Bare numbers ("1", "8453")
  // are typically chain ids — caller may put them in address slot by
  // mistake; we still flag.
  if (s.startsWith("0x")) {
    // Канонический tx hash / block hash / bytes32 slot — НЕ malformed-flag.
    // 0x + 64 hex = 66 chars total. Param[0] для
    // `eth_getTransactionReceipt`, `eth_getBlockByHash`, `eth_getStorageAt`.
    // Без exempt P1 V3 pool-resolver получал 400. 10-char shapes
    // (`0xdeadbeef`) остаются flagged — test coverage явно требует.
    // Block numbers / chain IDs (params[1] для eth_call etc.) НЕ
    // достигают этой функции потому что они skip'аются в
    // `handleRpcCall` — мы checks ТОЛЬКО params[0] для read-methods.
    if (s.length === 66 && /^0x[a-fA-F0-9]{64}$/.test(s)) return false;
    return true; // hex-ish but failed EVM regex (40 hex chars)
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{20,}$/.test(s)) return true; // long base58-ish
  return false;
}

/* ------------------------- per-provider extractors ------------------------ */

function extractDeBank(
  req: ProxyRequestForGuard,
  out: ExtractedAddress[],
  invalid: string[]
): void {
  // DeBank Pro takes the user address as `id` for most v1/user/* calls,
  // sometimes `addr` or `user_addr`. We grab whichever shows up.
  for (const key of ["id", "addr", "user_addr", "addresses", "addrs", "wallet"]) {
    const v = req.query[key];
    if (v !== undefined) pushFromAny(out, invalid, v, `query.${key}`);
  }
}

function extractHelius(
  req: ProxyRequestForGuard,
  out: ExtractedAddress[],
  invalid: string[]
): void {
  // Path: v0/addresses/<ADDR>/... → second segment.
  const parts = req.path.split("/").filter(Boolean);
  // `v0/addresses/<addr>/balances`, `v0/addresses/<addr>/transactions`,
  // `v0/addresses/<addr>/nft-events` — addr is parts[2].
  if (parts[0] === "v0" && parts[1] === "addresses" && parts[2]) {
    pushFromAny(out, invalid, parts[2], "path[addresses]");
  }
  // Common Helius POST bodies use { accounts: [addr, ...] } or
  // { addresses: [addr, ...] }.
  if (req.body && typeof req.body === "object") {
    const b = req.body as Record<string, unknown>;
    if (b.accounts !== undefined) pushFromAny(out, invalid, b.accounts, "body.accounts");
    if (b.addresses !== undefined) pushFromAny(out, invalid, b.addresses, "body.addresses");
  }
}

function extractEtherscan(
  req: ProxyRequestForGuard,
  out: ExtractedAddress[],
  invalid: string[]
): void {
  // Etherscan v2 unified API: address-семантика зависит от module:
  //   - module=account (balance, txlist, tokentx, txlistinternal, balancemulti)
  //     → address = USER wallet → enforce ownership
  //   - module=logs (getLogs) → address = CONTRACT emitter filter (public,
  //     не user data) → skip ownership
  //   - module=contract (getabi, getsourcecode) → contract address (public) → skip
  //   - module=stats / proxy → нет address param обычно
  //
  // useV3LiquidityEvents читает IncreaseLiquidity events с
  // NonfungiblePositionManager contract address (0xC3644...). Это
  // contract address, не user wallet → ownership check бы fail'ал
  // (POS-009/010 orphan stays orphan), хотя данные publicly indexable.
  const module = (
    Array.isArray(req.query.module) ? req.query.module[0] : req.query.module
  )?.toString().toLowerCase();
  const isAccountModule = module === "account";
  if (!isAccountModule) {
    // Non-account modules (logs, contract, stats, proxy) — public data.
    // НЕ extract'им address как user-owned. Address-guard пропустит
    // запрос (0 addresses to check → allow).
    return;
  }
  const v = req.query.address;
  if (v !== undefined) pushFromAny(out, invalid, v, "query.address");
}

function extractAlchemy(
  req: ProxyRequestForGuard,
  out: ExtractedAddress[],
  invalid: string[]
): void {
  // Alchemy = JSON-RPC over POST. Body is `{ method, params, … }` or a
  // batch array of such. Methods we care about (and where the addr
  // lives in `params`):
  //   eth_getBalance(addr, block)               → params[0]
  //   eth_getCode(addr, block)                  → params[0]
  //   eth_getStorageAt(addr, slot, block)       → params[0]
  //   eth_getTransactionCount(addr, block)      → params[0]
  //   eth_call({to: addr, data, from: addr})    → params[0].to/.from
  //   alchemy_getTokenBalances(addr, ...)       → params[0]
  //   alchemy_getTokenAllowance({contract, owner, spender})
  //                                             → params[0].owner
  //   alchemy_getAssetTransfers({ fromAddress, toAddress, ... })
  //                                             → params[0].from/.toAddress
  //   alchemy_getAssetsByOwner / DAS RPC        → params[0].ownerAddress
  // We err on the side of *seeing* every address-looking field rather
  // than missing one — the normalize() filter prevents false positives.
  const handleRpcCall = (call: unknown, idx: string): void => {
    if (!call || typeof call !== "object") return;
    const c = call as Record<string, unknown>;
    const params = c.params;
    if (params === undefined) return;
    // Most account-RPCs: params is an array, first element is the addr.
    if (Array.isArray(params)) {
      // `params[0]` may be string (addr) OR object (filter w/ from/to).
      walkParamElement(params[0], `body${idx}.params[0]`, out, invalid);
      // params[1+] для standard read-methods (`eth_call`, `eth_getBalance`,
      // `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`) — это
      // **block tag** (типа "latest" или hex block number "0x17de95d"), не
      // address. Раньше мы шли через все params шалово, но это давало false
      // positive на block numbers: `0x17de95d` (9 chars) НЕ адрес и НЕ
      // tx hash, но `looksLikeAddrAttempt` помечала как malformed.
      //
      // Для `eth_call` второй param — block tag. То же для других
      // account-методов. Single-param методы типа
      // `eth_getTransactionReceipt(txHash)` тут не задеваются (только
      // params[0] check'ается).
      //
      // Если в будущем появится метод где params[1+] — address slot, явно
      // добавим case-by-case через RPC method whitelist. Сейчас "shallow
      // for safety" walking создавал больше проблем чем решал.
    } else if (typeof params === "object" && params !== null) {
      // JSON-RPC by-name params (DAS RPC).
      walkParamElement(params, `body${idx}.params`, out, invalid);
    }
  };

  if (Array.isArray(req.body)) {
    req.body.forEach((c, i) => handleRpcCall(c, `[${i}]`));
  } else if (req.body && typeof req.body === "object") {
    handleRpcCall(req.body, "");
  }
}

const ADDR_PARAM_KEYS = new Set([
  "address",
  "from",
  "to",
  "fromAddress",
  "toAddress",
  "owner",
  "ownerAddress",
  "account",
  "contractAddress", // explicitly an asset, not user — skip via filter below
]);

// Keys that look address-shaped but are NOT user-owned (smart-contract
// addresses, system accounts). We collect them so the regex matches but
// we don't enforce ownership for them.
const NON_USER_KEYS = new Set(["contractAddress", "spender", "to", "tokenAddress"]);

function walkParamElement(
  el: unknown,
  source: string,
  out: ExtractedAddress[],
  invalid: string[]
): void {
  if (el === null || el === undefined) return;
  if (typeof el === "string") {
    // Bare string param — assume it's a user address slot. Caller is
    // responsible for not passing a contract addr as `eth_getBalance`
    // target (it'd still be theirs to query).
    pushFromAny(out, invalid, el, source);
    return;
  }
  if (Array.isArray(el)) {
    for (let i = 0; i < el.length; i++) {
      walkParamElement(el[i], `${source}[${i}]`, out, invalid);
    }
    return;
  }
  if (typeof el === "object") {
    for (const [k, v] of Object.entries(el)) {
      if (!ADDR_PARAM_KEYS.has(k)) continue;
      if (NON_USER_KEYS.has(k)) continue;
      pushFromAny(out, invalid, v, `${source}.${k}`);
    }
  }
}

function extractKrystal(
  req: ProxyRequestForGuard,
  out: ExtractedAddress[],
  invalid: string[]
): void {
  // Krystal Cloud REST API: address-семантика зависит от пути:
  //   - /v1/positions?wallet=<addr> → wallet — user-owned → enforce IDOR
  //   - /v1/balances?wallet=<addr>  → wallet — user-owned → enforce IDOR
  //   - /v1/pools, /v1/chains, /v1/protocols, /v1/strategies → public data,
  //     не имеют wallet/address param → skip ownership (allow)
  const path = req.path.toLowerCase();
  const isWalletScoped = /^v1\/(positions|balances)\b/.test(path);
  if (!isWalletScoped) return;
  const v = req.query.wallet;
  if (v !== undefined) pushFromAny(out, invalid, v, "query.wallet");
}

/* ------------------------- public extractor API --------------------------- */

export function extractAddresses(
  req: ProxyRequestForGuard
): { addresses: ExtractedAddress[]; invalid: string[] } {
  const out: ExtractedAddress[] = [];
  const invalid: string[] = [];
  switch (req.provider) {
    case "debank":
      extractDeBank(req, out, invalid);
      break;
    case "helius":
      extractHelius(req, out, invalid);
      break;
    case "etherscan":
      extractEtherscan(req, out, invalid);
      break;
    case "alchemy":
      extractAlchemy(req, out, invalid);
      break;
    case "krystal":
      extractKrystal(req, out, invalid);
      break;
    default:
      // Unknown providers are blocked one layer up in
      // UpstreamProxyService.forward; reaching here means we expanded
      // the registry without teaching the guard about it. Fail closed.
      invalid.push(`unsupported provider for guard: ${req.provider}`);
  }
  // Dedup on (normalized,kind) to keep enforcement O(1).
  const seen = new Set<string>();
  const deduped: ExtractedAddress[] = [];
  for (const a of out) {
    const k = `${a.kind}:${a.normalized}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(a);
  }
  return { addresses: deduped, invalid };
}

/* ------------------------- enforcement ------------------------------------ */

export interface OwnedAddressSet {
  has(normalized: string): boolean;
}

export function buildOwnedSet(
  rows: ReadonlyArray<{ address: string; type: string }>
): OwnedAddressSet {
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.address) continue;
    // EVM normalised lowercase; everything else verbatim.
    if (r.type === "evm" || EVM_HEX.test(r.address)) {
      set.add(r.address.toLowerCase());
    } else {
      set.add(r.address);
    }
  }
  return { has: (n) => set.has(n) };
}

export type GuardDecision =
  | { kind: "allow" }
  | { kind: "malformed"; message: string }
  | { kind: "forbidden"; message: string };

export function decide(
  req: ProxyRequestForGuard,
  owned: OwnedAddressSet,
  opts: { isAdmin: boolean }
): GuardDecision {
  const { addresses, invalid } = extractAddresses(req);
  if (invalid.length > 0) {
    return {
      kind: "malformed",
      message: `Malformed address in request: ${invalid.slice(0, 3).join("; ")}`,
    };
  }
  if (opts.isAdmin) return { kind: "allow" };
  for (const a of addresses) {
    if (!owned.has(a.normalized)) {
      return {
        kind: "forbidden",
        message: `Address not owned by caller (at ${a.source}). Add it under your wallets first.`,
      };
    }
  }
  return { kind: "allow" };
}
