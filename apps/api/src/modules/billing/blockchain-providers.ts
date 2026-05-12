/**
 * Real on-chain payment monitors for USDT transfers.
 *
 * Architecture:
 *   - Each provider implements `IBlockchainProvider.fetchIncoming(address)`.
 *   - Caller (PaymentMonitorService) is address-agnostic — providers do
 *     their own normalization (decimal places, hex case, confirmations
 *     mapping) so the upper layer just sees `BlockchainTx[]`.
 *   - When the API key isn't configured, the constructor still returns
 *     an instance — `fetchIncoming` then short-circuits to `[]`. The
 *     monitor pipeline runs cleanly either way; admins can swap providers
 *     at deploy time by toggling env.
 *
 * USDT contracts:
 *   TRC20: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t (6 decimals)
 *   ERC20: 0xdAC17F958D2ee523a2206206994597C13D831ec7 (6 decimals)
 */
export type CryptoNetwork = "trc20" | "erc20";

export interface BlockchainTx {
  readonly txHash: string;
  readonly fromAddress: string | null;
  readonly toAddress: string;
  /** Decimal-string USDT amount in human units (e.g. "100.000000"). */
  readonly amount: string;
  readonly confirmations: number;
}

export interface IBlockchainProvider {
  readonly network: CryptoNetwork;
  fetchIncoming(address: string): Promise<BlockchainTx[]>;
}

const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_ERC20_CONTRACT =
  "0xdAC17F958D2ee523a2206206994597C13D831ec7";

/** Always-empty provider. Used in tests + when no key is configured. */
export class MockBlockchainProvider implements IBlockchainProvider {
  constructor(public readonly network: CryptoNetwork) {}
  async fetchIncoming(): Promise<BlockchainTx[]> {
    return [];
  }
}

/**
 * Convert a raw on-chain amount (smallest units, integer string) into a
 * fixed-precision decimal string. USDT uses 6 decimals on both Tron and
 * Ethereum; we keep that as a parameter for forward-compat.
 */
function rawToHuman(raw: string | number, decimals: number): string {
  const s = String(raw);
  if (!/^\d+$/.test(s)) return "0";
  if (s.length <= decimals) {
    return `0.${s.padStart(decimals, "0")}`;
  }
  const head = s.slice(0, s.length - decimals);
  const tail = s.slice(s.length - decimals);
  return `${head}.${tail}`;
}

// ─────────────────────────────────────────────────────────────────────
//  Tronscan
// ─────────────────────────────────────────────────────────────────────

interface TronscanTransfer {
  readonly transaction_id: string;
  readonly from_address: string;
  readonly to_address: string;
  readonly quant: string; // smallest units as string
  readonly confirmed: boolean;
  readonly block_ts?: number;
}

interface TronscanResponse {
  readonly token_transfers?: TronscanTransfer[];
  readonly data?: TronscanTransfer[];
  readonly total?: number;
}

/**
 * Tronscan TRC20 client.
 *
 * Endpoint:
 *   GET https://apilist.tronscanapi.com/api/token_trc20/transfers
 *       ?relatedAddress=<address>
 *       &contract_address=<USDT_TRC20_CONTRACT>
 *       &limit=50&start=0&sort=-timestamp
 *
 * Free tier works without a key; key gives higher rate limits. The
 * response shape uses either `token_transfers` or `data` depending on
 * endpoint — we handle both.
 */
export class TronscanClient implements IBlockchainProvider {
  readonly network = "trc20" as const;
  private readonly base = "https://apilist.tronscanapi.com";

  constructor(private readonly apiKey: string | undefined) {}

  async fetchIncoming(address: string): Promise<BlockchainTx[]> {
    const url = new URL(`${this.base}/api/token_trc20/transfers`);
    url.searchParams.set("relatedAddress", address);
    url.searchParams.set("contract_address", USDT_TRC20_CONTRACT);
    url.searchParams.set("limit", "50");
    url.searchParams.set("start", "0");
    url.searchParams.set("sort", "-timestamp");

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) headers["TRON-PRO-API-KEY"] = this.apiKey;

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      throw new Error(`tronscan ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as TronscanResponse;
    const transfers = body.token_transfers ?? body.data ?? [];

    // Filter to *incoming* only (some endpoints return both directions).
    const out: BlockchainTx[] = [];
    for (const t of transfers) {
      if (!t.to_address || t.to_address.toLowerCase() !== address.toLowerCase()) continue;
      out.push({
        txHash: t.transaction_id,
        fromAddress: t.from_address ?? null,
        toAddress: t.to_address,
        amount: rawToHuman(t.quant, 6),
        // Tronscan exposes only a binary "confirmed". Map to a number high
        // enough that any reasonable `BILLING_MIN_CONFIRMATIONS_TRC20` is
        // satisfied for confirmed txs; unconfirmed stays at 0.
        confirmations: t.confirmed ? 200 : 0,
      });
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Etherscan (USDT tokentx)
// ─────────────────────────────────────────────────────────────────────

interface EtherscanTokenTx {
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly confirmations: string;
  readonly contractAddress: string;
  readonly tokenSymbol?: string;
  readonly tokenDecimal?: string;
}

interface EtherscanResponse {
  readonly status: string; // "1" on success, "0" on no results / error
  readonly message: string;
  readonly result: EtherscanTokenTx[] | string;
}

/**
 * Etherscan USDT ERC20 client.
 *
 * Endpoint:
 *   GET https://api.etherscan.io/api
 *       ?module=account&action=tokentx
 *       &contractaddress=<USDT_ERC20_CONTRACT>
 *       &address=<address>&apikey=<key>
 *
 * Note: Etherscan returns `status:"0"` and `result:"No transactions found"`
 * (string) when the address has no matching transfers — we treat that as
 * an empty list, not an error.
 */
export class EtherscanUsdtClient implements IBlockchainProvider {
  readonly network = "erc20" as const;
  private readonly base = "https://api.etherscan.io";

  constructor(private readonly apiKey: string | undefined) {}

  async fetchIncoming(address: string): Promise<BlockchainTx[]> {
    if (!this.apiKey) return [];

    const url = new URL(`${this.base}/api`);
    url.searchParams.set("module", "account");
    url.searchParams.set("action", "tokentx");
    url.searchParams.set("contractaddress", USDT_ERC20_CONTRACT);
    url.searchParams.set("address", address);
    url.searchParams.set("apikey", this.apiKey);
    url.searchParams.set("sort", "desc");

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`etherscan ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as EtherscanResponse;
    if (body.status !== "1" || typeof body.result === "string") {
      return [];
    }

    const out: BlockchainTx[] = [];
    for (const t of body.result) {
      // Etherscan returns both incoming + outgoing — keep incoming.
      if (t.to.toLowerCase() !== address.toLowerCase()) continue;
      // Defensive: ensure contract matches (Etherscan honors the filter
      // but we double-check on the off chance someone passed an address
      // that holds other USDT-flavoured tokens).
      if (t.contractAddress.toLowerCase() !== USDT_ERC20_CONTRACT.toLowerCase()) {
        continue;
      }
      const decimals = Number(t.tokenDecimal ?? 6);
      out.push({
        txHash: t.hash,
        fromAddress: t.from,
        toAddress: t.to,
        amount: rawToHuman(t.value, decimals),
        confirmations: Number(t.confirmations || "0"),
      });
    }
    return out;
  }
}
