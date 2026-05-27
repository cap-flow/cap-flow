import type { AuditService } from "../audit/audit.service.js";
import {
  decryptSecret,
  encryptSecret,
} from "../admin-integrations/secret-cipher.js";
import {
  NotFoundError,
  ValidationError,
  AppError,
} from "../../core/errors.js";

import type {
  CexAccountRow,
  CexRepository,
  CexP2pOrderRow,
  CexTransferRow,
} from "./cex.repository.js";
import {
  type CexClient,
  normalizeBalance,
  normalizeTrade,
} from "./cex.client.js";
import {
  chunkedFetchMyTrades,
  chunkedFetchTransfers,
  chunkedFetchTransfersPerAsset,
  HISTORICAL_DAYS_DEFAULT,
  TRANSFER_REQUIRES_COIN_FILTER,
} from "./cex.history.js";
import { normalizeCcxtTransfer } from "./cex.transfers.js";
import { normalizeCcxtInternalTransfer } from "./cex.internal-transfers.js";
import { normalizeCcxtLedger } from "./cex.ledger.js";
import {
  type CexCredentials,
  type CexPermissions,
  type ExchangeId,
  isSupportedExchange,
} from "./cex.types.js";
import type {
  IP2pClientFactory,
  P2pSyncResult,
} from "./cex.p2p.types.js";

/**
 * Indirection over `createCexClient` so tests can inject a fake without
 * spinning up real CCXT instances. Production wires this to
 * `createCexClient` from `cex.client.ts`.
 */
export type ICexClientFactory = (
  exchangeId: ExchangeId,
  creds: CexCredentials
) => CexClient;

export interface CexServiceConfig {
  /** 32-byte AES-256 key derived from a high-entropy seed (B5 cipher). */
  readonly cipherKey: Buffer;
}

export interface ConnectInput {
  readonly userId: string;
  readonly accountId: string;
  readonly exchange: string;
  readonly label: string | null;
  readonly credentials: CexCredentials;
}

export interface CexAccountPublic {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly exchange: string;
  readonly label: string | null;
  readonly permissions: unknown;
  readonly lastSyncedAt: Date | null;
  readonly lastSyncError: string | null;
  /** UCB B1.2 — separate trade-history sync state (опционально для backwards-compat). */
  readonly lastTradesSyncAt?: Date | null;
  readonly lastTradesSyncError?: string | null;
  readonly createdAt: Date;
}

export interface SyncResult {
  readonly ok: boolean;
  readonly balanceCount: number;
  readonly newTrades: number;
  readonly error?: string;
  /**
   * Non-fatal warning surfaced when balance sync succeeded but trade
   * history pull hit a recoverable problem (e.g. exchange requires a
   * per-symbol call and we couldn't enumerate symbols). The connection
   * is still healthy; the UI shows the warning as info, not red.
   */
  readonly tradesWarning?: string;
  /**
   * UCB B1.3: status каждого data-read эндпоинта по результату probe
   * (раз в sync). Клиент (B4 UI) ренедерит «coverage report» поверх
   * этих полей. Дефолт `unknown` если probe не запускался (auth fail).
   */
  readonly tradeHistoryStatus?: "ok" | "denied" | "unsupported" | "unknown";
  readonly depositsStatus?: "ok" | "denied" | "unsupported" | "unknown";
  readonly withdrawalsStatus?: "ok" | "denied" | "unsupported" | "unknown";
}

/**
 * Stable-quote candidates to try when an exchange demands per-symbol
 * `fetchMyTrades`. Order matters — USDT first because it's the most
 * liquid pair on Bybit/OKX/Bitget/MEXC/BingX.
 */
const TRADE_QUOTE_CANDIDATES = ["USDT", "USDC", "USD", "BTC", "ETH"] as const;

export interface TransfersSyncResult {
  readonly ok: boolean;
  readonly newDeposits: number;
  readonly newWithdrawals: number;
  readonly error?: string;
}

/**
 * Skip assets that almost never appear as a base on these exchanges —
 * trying `USDT/USDT` is wasteful and noisy.
 */
const NON_TRADABLE_ASSETS = new Set(["USDT", "USDC", "USD", "BUSD", "DAI", "TUSD"]);

/**
 * Strip encrypted secret blobs from a row before returning it through
 * the API. The encrypted ciphertext does not leak the key on its own,
 * but there's no reason to expose it — keep secrets server-side.
 */
function toPublic(row: CexAccountRow): CexAccountPublic {
  return {
    id: row.id,
    userId: row.userId,
    accountId: row.accountId,
    exchange: row.exchange,
    label: row.label,
    permissions: row.permissions,
    lastSyncedAt: row.lastSyncedAt,
    lastSyncError: row.lastSyncError,
    // Защита от drift с БД до того как миграция 0015 накачена: row
    // может не содержать новых полей — даём undefined через optional chain.
    lastTradesSyncAt:
      (row as { lastTradesSyncAt?: Date | null }).lastTradesSyncAt ?? null,
    lastTradesSyncError:
      (row as { lastTradesSyncError?: string | null }).lastTradesSyncError ??
      null,
    createdAt: row.createdAt,
  };
}

export class CexService {
  constructor(
    private readonly repo: CexRepository,
    private readonly audit: AuditService,
    private readonly clientFactory: ICexClientFactory,
    private readonly config: CexServiceConfig,
    /**
     * Optional — when omitted, syncP2p reports `supported:false` for
     * every exchange. In tests we pass a fake factory; in app.ts we
     * pass `createP2pClient`.
     */
    private readonly p2pClientFactory?: IP2pClientFactory
  ) {}

  /**
   * Validate exchange, probe key for `read` permission, encrypt the
   * triple, persist. Refuses keys without read (no point storing them)
   * and exchanges outside our whitelist (no `ccxt.evil-cex` injection).
   */
  async connect(input: ConnectInput): Promise<CexAccountPublic> {
    if (!isSupportedExchange(input.exchange)) {
      throw new ValidationError(
        `Unsupported exchange '${input.exchange}'. Supported: bybit, okx, bitget, mexc, bingx, binance.`
      );
    }

    let client: CexClient;
    try {
      client = this.clientFactory(
        input.exchange as ExchangeId,
        input.credentials
      );
    } catch (e) {
      // Construction-time errors: missing passphrase, missing exchange
      // constructor in CCXT, etc. These are user-input problems, not
      // server bugs — surface as 400, not 500.
      throw new ValidationError((e as Error).message);
    }

    let perms: CexPermissions;
    try {
      perms = await client.probePermissions();
    } catch (e) {
      // The probe itself swallows fetchBalance errors and returns
      // read:false, so reaching this catch means probePermissions
      // crashed on something unexpected.
      throw new AppError(
        `Failed to verify API key: ${(e as Error).message}`,
        502
      );
    }

    if (!perms.read) {
      const cause = (client as { probeError?: string | null }).probeError ?? "";

      // CDN-level geo block: Bybit/OKX/Bitget all sit behind CloudFront
      // and refuse non-USA/EU traffic at the edge. Telltale signs:
      // "CloudFront", "configured to block", "403 Forbidden" without a
      // JSON error body. The user's key is FINE — the server just can't
      // reach the exchange. We surface that directly so they don't
      // waste an hour rotating their key.
      const geoBlocked =
        /CloudFront|configured to block|block access from your country|451\b|geographic/i.test(
          cause
        );

      if (geoBlocked) {
        throw new ValidationError(
          `Биржа геоблокирует ваш сервер: ${cause}. Это блок на уровне CDN биржи (CloudFront / Cloudflare), не проблема ключа. ` +
            `Решение: запустить API через VPN/прокси с IP за пределами заблокированной страны (EU/SG/HK), либо деплоить прод-сервер в разрешённом регионе. ` +
            `Локальный dev: можно поставить VPN на уровне OS — но он должен работать и для Node-процесса (не только в браузере).`
        );
      }

      // Network timeout: the request never got a response. Common with
      // BingX/Bitget from RU/CIS IPs — the API endpoint is reachable
      // technically but consistently slow (or selectively throttled).
      // Distinct from a hard geo-block — sometimes works on retry,
      // sometimes not.
      const timedOut =
        /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|fetch failed/i.test(
          cause
        );

      if (timedOut) {
        throw new ValidationError(
          `Биржа не ответила за отведённое время: ${cause}. Это не проблема ключа — биржа недоступна / медленная с вашего IP. ` +
            `Попробуйте: (1) повторить через минуту, (2) запустить API через VPN, (3) использовать MEXC/Bitget которые часто работают без VPN.`
        );
      }

      throw new ValidationError(
        cause
          ? `Биржа отклонила запрос: ${cause}. Проверьте: (1) ключ/secret скопированы без пробелов, (2) включён scope 'Read', (3) IP whitelist пустой ИЛИ добавлен IP сервера, (4) для OKX/Bitget passphrase указана правильно.`
          : "API ключ не прошёл проверку на read-доступ. Проверьте scope 'Read' и IP whitelist."
      );
    }

    const apiKeyEnc = encryptSecret(input.credentials.apiKey, this.config.cipherKey);
    const apiSecretEnc = encryptSecret(
      input.credentials.apiSecret,
      this.config.cipherKey
    );
    const apiPassphraseEnc = input.credentials.apiPassphrase
      ? encryptSecret(input.credentials.apiPassphrase, this.config.cipherKey)
      : null;

    const row = await this.repo.insertAccount({
      userId: input.userId,
      accountId: input.accountId,
      exchange: input.exchange,
      label: input.label,
      apiKeyEnc,
      apiSecretEnc,
      apiPassphraseEnc,
      permissions: perms,
    });

    await this.audit.log({
      actorUserId: input.userId,
      action: "cex.connect",
      target: row.id,
      payload: { exchange: input.exchange, label: input.label },
    });

    return toPublic(row);
  }

  async list(userId: string): Promise<CexAccountPublic[]> {
    const rows = await this.repo.listActiveForUser(userId);
    return rows.map(toPublic);
  }

  async disconnect(id: string, userId: string): Promise<void> {
    await this.repo.archive(id, userId);
    await this.audit.log({
      actorUserId: userId,
      action: "cex.disconnect",
      target: id,
    });
  }

  /**
   * Pull fresh balance + new trades. Idempotent on re-run:
   *   - balance: one snapshot row per asset per sync (so history is
   *     preserved; we don't update-in-place)
   *   - trades: upsert by (cex_account_id, exchange_trade_id) so a
   *     re-run after partial failure adds only what's missing
   *
   * Auth / network failures are recorded in `last_sync_error` and
   * surfaced via `{ ok: false, error }`, NOT thrown — the UI lists
   * accounts with their last error, and a manual retry is cheap.
   */
  async sync(id: string, userId: string): Promise<SyncResult> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) {
      throw new NotFoundError(`CEX account ${id} not found.`);
    }

    let client: CexClient;
    try {
      const creds: CexCredentials = {
        apiKey: decryptSecret(row.apiKeyEnc, this.config.cipherKey),
        apiSecret: decryptSecret(row.apiSecretEnc, this.config.cipherKey),
        ...(row.apiPassphraseEnc
          ? {
              apiPassphrase: decryptSecret(
                row.apiPassphraseEnc,
                this.config.cipherKey
              ),
            }
          : {}),
      };
      client = this.clientFactory(row.exchange as ExchangeId, creds);
    } catch (e) {
      const msg = (e as Error).message;
      await this.repo.markSyncError(id, msg);
      return { ok: false, balanceCount: 0, newTrades: 0, error: msg };
    }

    const snapshotAt = new Date();

    // Step 1: balance — if this fails the whole sync is dead (auth / network).
    let balanceLines: ReturnType<typeof normalizeBalance>;
    try {
      const rawBalance = await client.fetchBalance();
      balanceLines = normalizeBalance(rawBalance, "spot");
      await this.repo.insertBalanceSnapshot(id, snapshotAt, balanceLines);
    } catch (e) {
      const raw = (e as Error).message || "fetchBalance failed";
      // Bitget/OKX from some regions sit behind slow / blocked CDN
      // edges; rewrite the cryptic CCXT timeout into something
      // actionable rather than dumping the URL at the user.
      const msg = /timed out|timeout|ETIMEDOUT|ECONNRESET/i.test(raw)
        ? `Биржа не ответила за 60s. Возможные причины: (1) перегрузка на стороне биржи, (2) гео-ограничение (Bitget из РФ часто требует VPN на сервере), (3) firewall блокирует исходящий HTTPS. Повторите попытку через минуту. Сырая ошибка: ${raw}`
        : raw;
      await this.repo.markSyncError(id, msg);
      return { ok: false, balanceCount: 0, newTrades: 0, error: msg };
    }

    // UCB B1.2: refresh permissions snapshot. Without this, ключ
    // мог быть пере-issued юзером с новыми правами, а мы бы продолжали
    // использовать старый snapshot. Также probe возвращает реальный
    // status `tradeHistory` (раньше всегда был unknown).
    let perms: Awaited<ReturnType<CexClient["probePermissions"]>> | null = null;
    try {
      perms = await client.probePermissions();
      await this.repo.updatePermissions(id, perms as unknown as Record<string, unknown>);
    } catch {
      // Probe не критичен для sync (balance уже OK); просто оставляем
      // старый permissions snapshot.
    }

    // Step 2: trades — best-effort, отдельная diagnostics channel
    // (last_trades_sync_at / last_trades_sync_error). Balance success
    // is NOT undone by trade-history problems.
    let newTrades = 0;
    let tradesWarning: string | undefined;
    const tradeHistoryStatus = perms?.tradeHistory ?? "unknown";

    if (tradeHistoryStatus === "denied") {
      // Пропускаем bessmysленный вызов fetchMyTrades — probe уже
      // подтвердил что permission denied. Пишем actionable hint,
      // user'у видно в UI.
      tradesWarning =
        `Trade history permission denied API-key'ом биржи. ` +
        `Чтобы появились данные о сделках: 1) на бирже перевыпустите ключ ` +
        `с правом «Read Spot Trade History» 2) обновите ключ в Capflow ` +
        `или нажмите «Re-probe permissions» 3) повторите Sync.`;
      await this.repo.markTradesSyncError(id, tradesWarning);
    } else if (tradeHistoryStatus === "unsupported") {
      // Биржа не имеет fetchMyTrades — это не ошибка, нечего делать.
      // tradesSyncError остаётся прежним (или null).
    } else {
      // 'ok' или 'unknown' — пробуем. Полагаемся на try/catch для
      // защиты, fetchAndStoreTrades также вернёт 0 если has.fetchMyTrades=false.
      try {
        newTrades = await this.fetchAndStoreTrades(
          id,
          client,
          balanceLines,
          row.exchange as ExchangeId,
        );
        await this.repo.markTradesSyncSuccess(id);
      } catch (e) {
        const raw = (e as Error).message ?? "trades fetch failed";
        tradesWarning = `Балансы обновлены, но история сделок недоступна: ${raw}`;
        await this.repo.markTradesSyncError(id, raw);
      }
    }

    // UCB B4: opportunistically chain ledger sync after main /sync.
    // Master record (trades + transfers + fees + rebates + interest +
    // staking + funding) — comprehensive entry stream. Fail-soft: errors
    // don't block main sync, recorded в last_ledger_sync_error namespace.
    try {
      await this.syncLedger(id, userId);
    } catch {
      // silent — ledger sync writes its own error marker
    }

    await this.repo.markSyncSuccess(id);
    // UCB B1.3: structured diagnostic snapshot. Каждый sync пишет
    // полную картину "что вытащилось, что нет, и почему" в audit_log.
    // Это позволяет:
    //   - B4 UI (Sync coverage report) читать историю без новой таблицы
    //   - support'у воспроизводить пользовательские проблемы по audit
    //   - отслеживать regression'ы в sync coverage по аккаунтам времени.
    const diagnostic = {
      balanceCount: balanceLines.length,
      newTrades,
      tradeHistoryStatus,
      depositsStatus: perms?.deposits ?? "unknown",
      withdrawalsStatus: perms?.withdrawals ?? "unknown",
      ...(tradesWarning ? { tradesWarning } : {}),
    };
    await this.audit.log({
      actorUserId: userId,
      action: "cex.sync",
      target: id,
      payload: diagnostic,
    });

    return {
      ok: true,
      balanceCount: balanceLines.length,
      newTrades,
      tradeHistoryStatus,
      depositsStatus: perms?.deposits ?? "unknown",
      withdrawalsStatus: perms?.withdrawals ?? "unknown",
      ...(tradesWarning ? { tradesWarning } : {}),
    };
  }

  /**
   * UCB B1.4: re-probe API-key permissions без полного sync. Используется
   * когда юзер обновил permission'ы на бирже (например включил «Read
   * Spot Trade History» на BingX) — нажимает «Re-probe» в Capflow UI,
   * мы обновляем `permissions` JSONB и возвращаем свежий snapshot.
   *
   * Не делает: не пишет балансы, не тащит trades. Только probe.
   */
  async reProbe(id: string, userId: string): Promise<CexPermissions | null> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) throw new NotFoundError(`CEX account ${id} not found.`);

    let client: CexClient;
    try {
      const creds: CexCredentials = {
        apiKey: decryptSecret(row.apiKeyEnc, this.config.cipherKey),
        apiSecret: decryptSecret(row.apiSecretEnc, this.config.cipherKey),
        ...(row.apiPassphraseEnc
          ? {
              apiPassphrase: decryptSecret(
                row.apiPassphraseEnc,
                this.config.cipherKey,
              ),
            }
          : {}),
      };
      client = this.clientFactory(row.exchange as ExchangeId, creds);
    } catch {
      return null;
    }
    const perms = await client.probePermissions();
    await this.repo.updatePermissions(id, perms as unknown as Record<string, unknown>);
    await this.audit.log({
      actorUserId: userId,
      action: "cex.reprobe",
      target: id,
      payload: { tradeHistory: perms.tradeHistory, deposits: perms.deposits },
    });
    return perms;
  }

  /**
   * Pull trade history. **UCB B1.5**: full-history sync через chunked
   * lookback per-exchange window (Bybit/BingX = 7 days max per CCXT
   * call, OKX = 90 days, MEXC = 30, Bitget retail handles itself).
   *
   * Strategy:
   *   1. Chunked main path: `chunkedFetchMyTrades(client, exchangeId)`.
   *      На первом sync лookback = HISTORICAL_DAYS_DEFAULT (1095 = 3y).
   *      На incremental — с `latestTradeTimestamp + 1`.
   *   2. Если biржа throw'ает "requires a symbol" (Bitget edge cases) →
   *      fallback на per-symbol iteration (с тем же since).
   *
   * Returns the count of NEW trades inserted (not the total fetched).
   * Errors per-window НЕ прерывают весь sync — собираются в
   * `result.errors` и игнорируются (балансы уже saved).
   */
  private async fetchAndStoreTrades(
    cexAccountId: string,
    client: CexClient,
    balanceLines: ReturnType<typeof normalizeBalance>,
    exchangeId: ExchangeId,
  ): Promise<number> {
    const supportsTrades =
      (client as unknown as { has?: { fetchMyTrades?: boolean | string } }).has
        ?.fetchMyTrades !== false;
    if (!supportsTrades || typeof client.fetchMyTrades !== "function") {
      return 0;
    }

    const sinceDate = await this.repo.latestTradeTimestamp(cexAccountId);
    const sinceMs = sinceDate
      ? sinceDate.getTime() + 1
      : Date.now() - HISTORICAL_DAYS_DEFAULT * 86_400_000;
    const untilMs = Date.now();

    const result = await chunkedFetchMyTrades(client, exchangeId, {
      since: sinceMs,
      until: untilMs,
    });
    let raw: unknown[] = result.items;

    // Fallback: если все окна errored на "requires symbol" — переключаемся
    // на per-symbol. Текущий fetchTradesPerSymbol не делает chunking
    // (один проход по балансам user'а × stable-quotes), но для bitget
    // это OK — у него own tax endpoint flow.
    const requiresSymbol =
      result.errors.length > 0 &&
      result.errors.some((e) =>
        /requires a symbol|symbol.*required|symbol.*argument/i.test(e.message),
      );
    if (raw.length === 0 && requiresSymbol) {
      raw = await this.fetchTradesPerSymbol(client, balanceLines, sinceMs);
    }

    // Если все окна errored И ничего не достали (и не requires-symbol) —
    // пробрасываем aggregated error чтобы caller-catch surface'нул его
    // через `last_trades_sync_error`. Без этого silent-fail: 0 trades с
    // запрещённым endpoint'ом выглядел бы как "user has no trades".
    if (raw.length === 0 && result.errors.length > 0 && !requiresSymbol) {
      const firstError = result.errors[0]!.message;
      throw new Error(
        result.errors.length === 1
          ? firstError
          : `${result.errors.length} chunked windows failed: ${firstError}`,
      );
    }

    const normalized = raw
      .map((t) => normalizeTrade(t as Parameters<typeof normalizeTrade>[0]))
      .filter((t): t is NonNullable<typeof t> => t !== null)
      .map((t) => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side,
        amount: t.amount,
        price: t.price,
        cost: t.cost,
        feeCurrency: t.fee?.currency ?? null,
        feeAmount: t.fee?.cost ?? null,
        taker: t.takerOrMaker ?? null,
        executedAt: new Date(t.executedAtMs),
      }));
    return this.repo.upsertTrades(cexAccountId, normalized);
  }

  /**
   * For exchanges that demand a per-symbol fetch, walk every asset the
   * user actually holds (from balance) and try common quote pairs. An
   * exchange that doesn't recognize the symbol throws "bad symbol" or
   * similar — we swallow those (cheap) and move on. Network errors are
   * NOT swallowed (they'd hide a wider outage).
   */
  private async fetchTradesPerSymbol(
    client: CexClient,
    balanceLines: ReturnType<typeof normalizeBalance>,
    since: number | undefined
  ): Promise<unknown[]> {
    const bases = Array.from(
      new Set(
        balanceLines
          .map((l) => l.asset)
          .filter((a) => !NON_TRADABLE_ASSETS.has(a))
      )
    );
    const out: unknown[] = [];
    for (const base of bases) {
      for (const quote of TRADE_QUOTE_CANDIDATES) {
        if (base === quote) continue;
        const symbol = `${base}/${quote}`;
        try {
          const r = (await client.fetchMyTrades(symbol, since)) as unknown[];
          if (Array.isArray(r) && r.length > 0) {
            out.push(...r);
          }
          // If the call succeeded for this quote (returned ANY array,
          // including []), the symbol is valid on this exchange. Don't
          // keep trying other quotes for the same base — saves N×
          // pointless requests against the rate-limit.
          if (Array.isArray(r)) break;
        } catch (e) {
          const m = (e as Error).message ?? "";
          // Swallow "exchange doesn't list this pair" errors so the
          // loop keeps trying the user's other assets. The wording
          // varies per exchange:
          //   - Bitget:  "does not have market symbol X/Y"
          //   - OKX:     "Instrument id does not exist"
          //   - Bybit:   "Invalid symbol" / "symbol not found"
          //   - MEXC:    "Symbol not support"
          //   - Generic CCXT: "BadSymbol" / "market not found"
          // Auth / network / 5xx errors re-throw so the caller can
          // surface a real warning.
          if (
            !/bad ?symbol|not ?found|not ?support|not exist|does not have|invalid symbol|unknown symbol/i.test(
              m
            )
          ) {
            throw e;
          }
        }
      }
    }
    return out;
  }

  // ─── P2P ──────────────────────────────────────────────────────────

  /**
   * Pull P2P (fiat) order history for one CEX account.
   *
   *   - `supported:false` when this exchange doesn't have a P2P
   *     adapter yet — UI greys the button out rather than 500-ing.
   *   - `ok:false` when the adapter exists but the call failed (most
   *     commonly: key missing the P2P scope). `error` carries the
   *     underlying message; UI shows it so user knows to re-create
   *     the key.
   *   - Idempotent via upsert; safe to re-run.
   */
  async syncP2p(id: string, userId: string): Promise<P2pSyncResult> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) {
      throw new NotFoundError(`CEX account ${id} not found.`);
    }

    if (!this.p2pClientFactory) {
      return { ok: false, supported: false, newOrders: 0 };
    }

    let creds: CexCredentials;
    try {
      creds = {
        apiKey: decryptSecret(row.apiKeyEnc, this.config.cipherKey),
        apiSecret: decryptSecret(row.apiSecretEnc, this.config.cipherKey),
        ...(row.apiPassphraseEnc
          ? {
              apiPassphrase: decryptSecret(
                row.apiPassphraseEnc,
                this.config.cipherKey
              ),
            }
          : {}),
      };
    } catch (e) {
      return {
        ok: false,
        supported: true,
        newOrders: 0,
        error: (e as Error).message,
      };
    }

    const client = this.p2pClientFactory(row.exchange as ExchangeId, creds);
    if (!client) {
      return { ok: false, supported: false, newOrders: 0 };
    }

    let newOrders = 0;
    try {
      const sinceDate = await this.repo.latestP2pTimestamp(id);
      const since = sinceDate ? new Date(sinceDate.getTime() + 1) : undefined;
      const lines = await client.fetchP2pOrders(since);
      const records = lines.map((l) => ({
        id: l.id,
        side: l.side,
        asset: l.asset,
        amount: l.amount,
        // Fiat fields are nullable — Bitget retail tax API omits them.
        fiatCurrency: l.fiatCurrency ?? null,
        fiatAmount: l.fiatAmount ?? null,
        unitPrice: l.unitPrice ?? null,
        counterparty: l.counterparty,
        paymentMethod: l.paymentMethod,
        status: l.status,
        executedAt: new Date(l.executedAtMs),
      }));
      newOrders = await this.repo.upsertP2pOrders(id, records);
    } catch (e) {
      const msg = (e as Error).message || "P2P sync failed";
      await this.audit.log({
        actorUserId: userId,
        action: "cex.p2p_sync_error",
        target: id,
        payload: { error: msg.slice(0, 500) },
      });
      return { ok: false, supported: true, newOrders: 0, error: msg };
    }

    await this.audit.log({
      actorUserId: userId,
      action: "cex.p2p_sync",
      target: id,
      payload: { newOrders },
    });
    return { ok: true, supported: true, newOrders };
  }

  /**
   * Insert a P2P order the user typed in by hand. Used when:
   *   - the exchange has no public P2P API (BingX)
   *   - user's key lacks merchant scope and tax endpoint returned
   *     nothing for some period
   *   - user wants to record an old P2P trade older than the
   *     exchange's 90-day retention
   *
   * Auth-gated via the parent CEX account.
   */
  async createManualP2pOrder(
    cexAccountId: string,
    userId: string,
    input: {
      side: "buy" | "sell";
      asset: string;
      amount: number;
      fiatCurrency: string;
      fiatAmount: number;
      unitPrice?: number | null;
      counterparty?: string | null;
      paymentMethod?: string | null;
      status?: string;
      executedAt: Date;
    }
  ): Promise<CexP2pOrderRow> {
    const owner = await this.repo.findActiveById(cexAccountId, userId);
    if (!owner) throw new NotFoundError(`CEX account ${cexAccountId} not found.`);
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new ValidationError("amount должно быть > 0");
    }
    if (!Number.isFinite(input.fiatAmount) || input.fiatAmount <= 0) {
      throw new ValidationError("fiatAmount должно быть > 0");
    }
    const unit =
      input.unitPrice != null && input.unitPrice > 0
        ? input.unitPrice
        : input.fiatAmount / input.amount;
    const row = await this.repo.insertManualP2pOrder({
      cexAccountId,
      side: input.side,
      asset: input.asset,
      amount: input.amount,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
      unitPrice: unit,
      counterparty: input.counterparty ?? null,
      paymentMethod: input.paymentMethod ?? null,
      status: input.status ?? "completed",
      executedAt: input.executedAt,
    });
    await this.audit.log({
      actorUserId: userId,
      action: "cex.p2p_manual_created",
      target: row.id,
      payload: {
        side: input.side,
        asset: input.asset,
        fiatCurrency: input.fiatCurrency,
      },
    });
    return row;
  }

  /**
   * Manually fill in the fiat-leg fields on a single P2P order. Used
   * by the «✏ указать фиат» dialog because Bitget retail API hides
   * those fields. Auth-gated via the parent CEX account: the order
   * must belong to a non-archived account owned by `userId`.
   *
   * `unitPrice` defaults to `fiatAmount / amount` if the user omits it.
   */
  async updateP2pOrderFiat(
    orderId: string,
    userId: string,
    patch: {
      fiatCurrency: string | null;
      fiatAmount: number | null;
      unitPrice?: number | null;
      counterparty?: string | null;
      paymentMethod?: string | null;
    },
    source: "manual" | "csv" | "merchant" = "manual"
  ): Promise<CexP2pOrderRow> {
    const row = await this.repo.findP2pOrderById(orderId);
    if (!row) throw new NotFoundError(`P2P order ${orderId} not found.`);
    const owner = await this.repo.findActiveById(row.cexAccountId, userId);
    if (!owner)
      throw new NotFoundError(`P2P order ${orderId} not found.`);

    const orderAmount = Number(row.amount);
    let unit = patch.unitPrice ?? null;
    if (
      unit == null &&
      patch.fiatAmount != null &&
      Number.isFinite(orderAmount) &&
      orderAmount > 0
    ) {
      unit = patch.fiatAmount / orderAmount;
    }

    await this.repo.updateP2pOrderFiat(orderId, {
      fiatCurrency: patch.fiatCurrency
        ? patch.fiatCurrency.toUpperCase()
        : null,
      fiatAmount: patch.fiatAmount,
      unitPrice: unit,
      ...(patch.counterparty !== undefined
        ? { counterparty: patch.counterparty }
        : {}),
      ...(patch.paymentMethod !== undefined
        ? { paymentMethod: patch.paymentMethod }
        : {}),
      fiatSource: source,
    });
    await this.audit.log({
      actorUserId: userId,
      action: "cex.p2p_fiat_annotated",
      target: orderId,
      payload: {
        source,
        fiatCurrency: patch.fiatCurrency,
        // Don't log amounts in plaintext audit payload — keep just the
        // shape so we know SOMETHING was set.
        hasFiatAmount: patch.fiatAmount != null,
      },
    });
    const updated = await this.repo.findP2pOrderById(orderId);
    if (!updated) throw new Error("update lost the row");
    return updated;
  }

  /**
   * Bulk-update P2P orders' fiat fields from a CSV import. Matching
   * by Bitget order id within ONE cex_account. Counters: how many
   * existing rows got updated, how many CSV lines didn't match anything.
   */
  /**
   * UCB B6: import trade-history из CSV/XLSX-выгрузки биржи. Клиент
   * парсит файл (форматы Bybit/BingX/OKX/MEXC) и шлёт уже нормализованные
   * rows — backend просто upsert'ает через unique `(account, exchangeTradeId)`
   * index, поэтому повторный import тех же данных не создаёт дубликатов.
   *
   * Зачем нужно: на бирже API имеет hard-limit lookback (Bybit 2 года, MEXC
   * 90 дней, и т.п.). Trade-history до этих лимитов недоступна — но user
   * может выгрузить её в CSV/XLSX на сайте биржи (Bybit «Trade History
   * Statement», BingX «Order History Export») и импортировать.
   *
   * Возвращает `{ inserted, skipped, total }`:
   *   - inserted: записей added через upsert
   *   - skipped:  с invalid fields (zero amount/price, missing fields)
   *   - total:    всего rows в request
   */
  async importTradesCsv(
    cexAccountId: string,
    userId: string,
    rows: ReadonlyArray<{
      exchangeTradeId: string;
      symbol: string;
      side: "buy" | "sell";
      amount: number;
      price: number;
      cost: number;
      feeCurrency?: string | null;
      feeAmount?: number | null;
      executedAt: string; // ISO datetime
    }>,
  ): Promise<{ inserted: number; skipped: number; total: number }> {
    const owner = await this.repo.findActiveById(cexAccountId, userId);
    if (!owner) throw new NotFoundError(`CEX account ${cexAccountId} not found.`);

    const valid: Array<{
      id: string;
      symbol: string;
      side: "buy" | "sell";
      amount: number;
      price: number;
      cost: number;
      feeCurrency: string | null;
      feeAmount: number | null;
      taker: string | null;
      executedAt: Date;
    }> = [];
    let skipped = 0;
    for (const r of rows) {
      if (!r.exchangeTradeId || !r.symbol || !r.executedAt) {
        skipped++;
        continue;
      }
      if (!(r.side === "buy" || r.side === "sell")) {
        skipped++;
        continue;
      }
      if (!Number.isFinite(r.amount) || r.amount <= 0) {
        skipped++;
        continue;
      }
      if (!Number.isFinite(r.price) || r.price <= 0) {
        skipped++;
        continue;
      }
      const cost = Number.isFinite(r.cost) && r.cost > 0 ? r.cost : r.amount * r.price;
      const executedAt = new Date(r.executedAt);
      if (Number.isNaN(executedAt.getTime())) {
        skipped++;
        continue;
      }
      valid.push({
        id: r.exchangeTradeId,
        symbol: r.symbol.toUpperCase(),
        side: r.side,
        amount: r.amount,
        price: r.price,
        cost,
        feeCurrency: r.feeCurrency ?? null,
        feeAmount: r.feeAmount ?? null,
        taker: null,
        executedAt,
      });
    }
    // Используем `overwrite` mode: при duplicate exchange_trade_id
    // CSV-import обновляет существующий row (важно когда user re-importит
    // после parser-fix-а, например после исправления timezone-bug-а).
    const inserted = await this.repo.upsertTrades(cexAccountId, valid, "overwrite");
    await this.audit.log({
      actorUserId: userId,
      action: "cex.trades_csv_import",
      target: cexAccountId,
      payload: { inserted, skipped, total: rows.length },
    });
    return { inserted, skipped, total: rows.length };
  }

  async importP2pCsv(
    cexAccountId: string,
    userId: string,
    rows: ReadonlyArray<{
      orderId: string;
      fiatCurrency: string;
      fiatAmount: number;
      unitPrice?: number;
      counterparty?: string | null;
      paymentMethod?: string | null;
    }>
  ): Promise<{ matched: number; unmatched: number; total: number }> {
    const owner = await this.repo.findActiveById(cexAccountId, userId);
    if (!owner) throw new NotFoundError(`CEX account ${cexAccountId} not found.`);

    const existing = await this.repo.listP2pOrders(cexAccountId, 5000);
    const byExchangeId = new Map(existing.map((r) => [r.exchangeOrderId, r]));

    let matched = 0;
    let unmatched = 0;
    for (const r of rows) {
      const target = byExchangeId.get(r.orderId);
      if (!target) {
        unmatched++;
        continue;
      }
      const amount = Number(target.amount);
      const unit =
        r.unitPrice ?? (amount > 0 ? r.fiatAmount / amount : null);
      await this.repo.updateP2pOrderFiat(target.id, {
        fiatCurrency: r.fiatCurrency.toUpperCase(),
        fiatAmount: r.fiatAmount,
        unitPrice: unit,
        counterparty: r.counterparty ?? null,
        paymentMethod: r.paymentMethod ?? null,
        fiatSource: "csv",
      });
      matched++;
    }
    await this.audit.log({
      actorUserId: userId,
      action: "cex.p2p_csv_import",
      target: cexAccountId,
      payload: { matched, unmatched, total: rows.length },
    });
    return { matched, unmatched, total: rows.length };
  }

  async listP2pOrders(
    id: string,
    userId: string,
    limit = 200
  ): Promise<Array<CexP2pOrderRow & { mergedCount: number }>> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) {
      throw new NotFoundError(`CEX account ${id} not found.`);
    }
    const raw = await this.repo.listP2pOrders(id, limit);
    return dedupP2pOrders(raw);
  }

  // ─── Transfers (deposits / withdrawals) ──────────────────────────

  /**
   * Pull crypto deposit + withdrawal history for one CEX account via
   * CCXT's unified `fetchDeposits()` / `fetchWithdrawals()`. Both
   * directions are pulled in one sync — failure on one is reported
   * via the result, the other still completes.
   *
   *   - Idempotent (upsert on `(cex_account_id, exchange_transfer_id)`).
   *   - `since` defaults to the latest stored transfer timestamp + 1ms;
   *     full history on first sync (no `since`).
   */
  async syncTransfers(
    id: string,
    userId: string
  ): Promise<TransfersSyncResult> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) {
      throw new NotFoundError(`CEX account ${id} not found.`);
    }

    let client: CexClient;
    try {
      const creds: CexCredentials = {
        apiKey: decryptSecret(row.apiKeyEnc, this.config.cipherKey),
        apiSecret: decryptSecret(row.apiSecretEnc, this.config.cipherKey),
        ...(row.apiPassphraseEnc
          ? {
              apiPassphrase: decryptSecret(
                row.apiPassphraseEnc,
                this.config.cipherKey
              ),
            }
          : {}),
      };
      client = this.clientFactory(row.exchange as ExchangeId, creds);
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, newDeposits: 0, newWithdrawals: 0, error: msg };
    }

    const sinceDate = await this.repo.latestTransferTimestamp(id);
    // UCB B2: chunked deposits/withdrawals на full HISTORICAL_DAYS_DEFAULT
    // при первом sync (cap per-exchange в TRANSFER_MAX_LOOKBACK_DAYS).
    const sinceMs = sinceDate
      ? sinceDate.getTime() + 1
      : Date.now() - HISTORICAL_DAYS_DEFAULT * 86_400_000;
    const untilMs = Date.now();
    const exchangeId = row.exchange as ExchangeId;

    // UCB B2.5: Bybit/BingX `fetchDeposits/Withdrawals` без `coin` filter
    // возвращают empty array — нужно итерировать по каждому asset из
    // balance. Для других бирж — single chunked call.
    const requiresCoin = TRANSFER_REQUIRES_COIN_FILTER[exchangeId];
    let assetsForIteration: string[] = [];
    if (requiresCoin) {
      // Берём все assets когда-либо торгуемые user'ом на этой бирже из
      // `cex_trades` (split symbol BASE/QUOTE) + stable fallback. Это
      // safest: даже если у user'а сейчас 0 balance, мы пройдёмся по
      // всем coin'ам через которые он когда-либо торговал.
      const tradeSymbols = await this.repo
        .listTradesForAccount(id)
        .then((rows) => rows.map((r) => r.symbol));
      const fromTrades = new Set<string>();
      for (const s of tradeSymbols) {
        const parts = s.split("/");
        if (parts[0]) fromTrades.add(parts[0].toUpperCase());
        if (parts[1]) fromTrades.add(parts[1].toUpperCase());
      }
      const stableFallback = ["USDT", "USDC", "ETH", "BTC", "WBTC"];
      assetsForIteration = Array.from(
        new Set([...fromTrades, ...stableFallback]),
      );
    }

    let newDeposits = 0;
    let newWithdrawals = 0;
    const errors: string[] = [];

    try {
      const fetcher = (
        asset: string | undefined,
        sinceArg: number,
        _limit: number | undefined,
        params: Record<string, unknown>,
      ) => client.fetchDeposits(asset, sinceArg, undefined, params) as Promise<unknown[]>;
      const result = requiresCoin
        ? await chunkedFetchTransfersPerAsset(fetcher, exchangeId, assetsForIteration, {
            since: sinceMs,
            until: untilMs,
          })
        : await chunkedFetchTransfers(fetcher, exchangeId, { since: sinceMs, until: untilMs });
      if (result.items.length === 0 && result.errors.length > 0) {
        errors.push(`deposits: ${result.errors[0]!.message}`);
      }
      newDeposits = await this.storeTransfers(id, result.items, "deposit");
    } catch (e) {
      errors.push(`deposits: ${(e as Error).message}`);
    }
    try {
      const fetcher = (
        asset: string | undefined,
        sinceArg: number,
        _limit: number | undefined,
        params: Record<string, unknown>,
      ) => client.fetchWithdrawals(asset, sinceArg, undefined, params) as Promise<unknown[]>;
      const result = requiresCoin
        ? await chunkedFetchTransfersPerAsset(fetcher, exchangeId, assetsForIteration, {
            since: sinceMs,
            until: untilMs,
          })
        : await chunkedFetchTransfers(fetcher, exchangeId, { since: sinceMs, until: untilMs });
      if (result.items.length === 0 && result.errors.length > 0) {
        errors.push(`withdrawals: ${result.errors[0]!.message}`);
      }
      newWithdrawals = await this.storeTransfers(id, result.items, "withdrawal");
    } catch (e) {
      errors.push(`withdrawals: ${(e as Error).message}`);
    }

    // UCB Bob-test fix #3: opportunistically sync internal transfers
    // (Spot↔Funding↔Earn). Раньше user должен был manually нажимать
    // "Sync internal" в UI — большинство users не знали о такой кнопке.
    //
    // Fail-soft: ошибки internal-transfers НЕ влияют на ok/errors[]
    // transfers sync — у internal-transfers свой `last_internal_transfers_sync_error`
    // в БД. Это namespace separation: transfers sync касается только
    // deposit/withdrawal flow.
    try {
      await this.syncInternalTransfers(id, userId);
    } catch {
      // Полностью silent — internal sync сам markedSyncError internally.
    }

    const ok = errors.length === 0;
    // UCB Bob-test fix #1: persist sync state в DB чтобы Sync Coverage
    // UI surface'ила partial failures. Раньше errors[] возвращался только
    // в HTTP response — `cex_accounts.last_sync_error` оставался NULL и
    // UI показывал "OK" silently.
    if (ok) {
      await this.repo.markSyncSuccess(id);
    } else {
      await this.repo.markSyncError(id, errors.join("; ").slice(0, 1000));
    }
    await this.audit.log({
      actorUserId: userId,
      action: ok ? "cex.transfers_sync" : "cex.transfers_sync_partial",
      target: id,
      payload: {
        newDeposits,
        newWithdrawals,
        ...(errors.length > 0 ? { errors } : {}),
      },
    });
    return {
      ok,
      newDeposits,
      newWithdrawals,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  }

  private async storeTransfers(
    cexAccountId: string,
    raw: unknown[],
    fallbackDirection: "deposit" | "withdrawal"
  ): Promise<number> {
    const normalized = raw
      .map((r) =>
        normalizeCcxtTransfer(
          r as Parameters<typeof normalizeCcxtTransfer>[0],
          fallbackDirection
        )
      )
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map((x) => ({
        id: x.id,
        direction: x.direction,
        asset: x.asset,
        amount: x.amount,
        feeAmount: x.feeAmount,
        feeCurrency: x.feeCurrency,
        network: x.network,
        address: x.address,
        txHash: x.txHash,
        status: x.status,
        executedAt: new Date(x.executedAtMs),
      }));
    return this.repo.upsertTransfers(cexAccountId, normalized);
  }

  async listTransfers(
    id: string,
    userId: string,
    limit = 200
  ): Promise<CexTransferRow[]> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) {
      throw new NotFoundError(`CEX account ${id} not found.`);
    }
    return this.repo.listTransfers(id, limit);
  }

  /**
   * All CEX transfers for the user across every active account, with
   * the matching tx_hash. Used by the dashboard to render the
   * "↔ Bitget" badge on on-chain ops that pair with a CEX move.
   */
  async listAllTransfersWithHashForUser(userId: string) {
    return this.repo.listAllTransfersWithHashForUser(userId);
  }

  // ─── UCB B3: internal transfers (Spot ↔ Funding ↔ Earn ↔ Sub-account) ─

  /**
   * Тянет всю историю internal transfers через CCXT `fetchTransfers`.
   *
   * Bybit/BingX требуют per-coin filter (как в B2.5) — итерируем по
   * каждому asset из trade history + stable fallback. Bitget может
   * принять single call без coin.
   *
   * `fetchTransfers` НЕ поддержан некоторыми exchanges (CCXT throws
   * `NotSupported`). В этом случае помечаем sync как error и user видит
   * actionable hint в UI ("Bitget doesn't expose internal transfers").
   */
  async syncInternalTransfers(
    id: string,
    userId: string,
  ): Promise<{
    readonly ok: boolean;
    readonly newCount: number;
    readonly error?: string;
  }> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) {
      throw new NotFoundError(`CEX account ${id} not found.`);
    }

    let client: CexClient;
    try {
      const creds: CexCredentials = {
        apiKey: decryptSecret(row.apiKeyEnc, this.config.cipherKey),
        apiSecret: decryptSecret(row.apiSecretEnc, this.config.cipherKey),
        ...(row.apiPassphraseEnc
          ? {
              apiPassphrase: decryptSecret(
                row.apiPassphraseEnc,
                this.config.cipherKey,
              ),
            }
          : {}),
      };
      client = this.clientFactory(row.exchange as ExchangeId, creds);
    } catch (e) {
      const msg = (e as Error).message;
      await this.repo.markInternalTransfersSyncError(id, msg);
      return { ok: false, newCount: 0, error: msg };
    }

    // CCXT exposes `fetchTransfers` natively на Exchange — но некоторые
    // exchanges его не имплементируют. Проверяем capability.
    if (typeof client.fetchTransfers !== "function") {
      const msg = `${row.exchange}: fetchTransfers not supported by CCXT`;
      await this.repo.markInternalTransfersSyncError(id, msg);
      return { ok: false, newCount: 0, error: msg };
    }

    const sinceDate = await this.repo.latestInternalTransferTimestamp(id);
    const sinceMs = sinceDate
      ? sinceDate.getTime() + 1
      : Date.now() - HISTORICAL_DAYS_DEFAULT * 86_400_000;
    const untilMs = Date.now();
    const exchangeId = row.exchange as ExchangeId;

    const requiresCoin = TRANSFER_REQUIRES_COIN_FILTER[exchangeId];
    let assetsForIteration: string[] = [];
    if (requiresCoin) {
      const tradeSymbols = await this.repo
        .listTradesForAccount(id)
        .then((rows) => rows.map((r) => r.symbol));
      const fromTrades = new Set<string>();
      for (const s of tradeSymbols) {
        const parts = s.split("/");
        if (parts[0]) fromTrades.add(parts[0].toUpperCase());
        if (parts[1]) fromTrades.add(parts[1].toUpperCase());
      }
      const stableFallback = ["USDT", "USDC", "ETH", "BTC"];
      assetsForIteration = Array.from(
        new Set([...fromTrades, ...stableFallback]),
      );
    }

    let newCount = 0;
    const errors: string[] = [];

    try {
      const fetcher = (
        asset: string | undefined,
        sinceArg: number,
        _limit: number | undefined,
        params: Record<string, unknown>,
      ) =>
        client.fetchTransfers(asset, sinceArg, undefined, params) as Promise<
          unknown[]
        >;
      const result = requiresCoin
        ? await chunkedFetchTransfersPerAsset(
            fetcher,
            exchangeId,
            assetsForIteration,
            { since: sinceMs, until: untilMs },
          )
        : await chunkedFetchTransfers(fetcher, exchangeId, {
            since: sinceMs,
            until: untilMs,
          });
      // Softening: для бирж которые свали permission denied нет смысла
      // считать errors fatal — multiple chunks могут вернуть ok даже
      // если один chunk упал.
      if (result.items.length === 0 && result.errors.length > 0) {
        errors.push(result.errors[0]!.message);
      }
      newCount = await this.storeInternalTransfers(id, result.items);
    } catch (e) {
      errors.push((e as Error).message);
    }

    const ok = errors.length === 0;
    if (ok) {
      await this.repo.markInternalTransfersSyncSuccess(id);
    } else {
      await this.repo.markInternalTransfersSyncError(id, errors.join("; "));
    }
    await this.audit.log({
      actorUserId: userId,
      action: ok
        ? "cex.internal_transfers_sync"
        : "cex.internal_transfers_sync_partial",
      target: id,
      payload: {
        newCount,
        ...(errors.length > 0 ? { errors } : {}),
      },
    });
    return {
      ok,
      newCount,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  }

  private async storeInternalTransfers(
    cexAccountId: string,
    raw: unknown[],
  ): Promise<number> {
    const normalized = raw
      .map((r) =>
        normalizeCcxtInternalTransfer(
          r as Parameters<typeof normalizeCcxtInternalTransfer>[0],
        ),
      )
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map((x) => ({
        id: x.id,
        asset: x.asset,
        amount: x.amount,
        fromAccount: x.fromAccount,
        toAccount: x.toAccount,
        status: x.status,
        executedAt: new Date(x.executedAtMs),
        raw: x.raw,
      }));
    return this.repo.upsertInternalTransfers(cexAccountId, normalized);
  }

  async listInternalTransfers(id: string, userId: string, limit = 200) {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) throw new NotFoundError(`CEX account ${id} not found.`);
    return this.repo.listInternalTransfers(id, limit);
  }

  // ─── UCB B4: fetchLedger sync (master record всех balance entries) ──

  /**
   * Pull comprehensive ledger через CCXT `fetchLedger`. Возвращает
   * единый stream всех balance-affecting movements:
   *   trades + deposits + withdrawals + internal transfers + fees +
   *   rebates + interest + staking + funding.
   *
   * Pagination: backward iteration с `since` параметром. Запрос batch'а
   * с `since = oldest_returned - 1`, повторяем пока биржа возвращает
   * новые entries. Это позволяет вытащить ВСЮ историю аккаунта (не
   * только last 90d по default CCXT window).
   *
   * Idempotent: upsert через unique (cex_account_id, exchange_entry_id).
   * Повторный sync только добавит новые entries (existing skip).
   *
   * Note: некоторые exchanges не support'ят fetchLedger или возвращают
   * subset (e.g. Bitget — частично). Failure handled fail-soft (records
   * error в last_ledger_sync_error).
   */
  async syncLedger(
    id: string,
    userId: string,
  ): Promise<{
    readonly ok: boolean;
    readonly newCount: number;
    readonly error?: string;
  }> {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) throw new NotFoundError(`CEX account ${id} not found.`);

    let client: CexClient;
    try {
      const creds: CexCredentials = {
        apiKey: decryptSecret(row.apiKeyEnc, this.config.cipherKey),
        apiSecret: decryptSecret(row.apiSecretEnc, this.config.cipherKey),
        ...(row.apiPassphraseEnc
          ? {
              apiPassphrase: decryptSecret(
                row.apiPassphraseEnc,
                this.config.cipherKey,
              ),
            }
          : {}),
      };
      client = this.clientFactory(row.exchange as ExchangeId, creds);
    } catch (e) {
      const msg = (e as Error).message;
      await this.repo.markLedgerSyncError(id, msg);
      return { ok: false, newCount: 0, error: msg };
    }

    // Early bail-out for exchanges where CCXT has not implemented
    // fetchLedger. CCXT signals this via `client.has.fetchLedger`
    // (either `false` or `"emulated"`). The method itself often exists
    // as a stub that throws `NotSupported`, so a `typeof === "function"`
    // check is insufficient — without `has`-gating we'd spam the audit
    // log with per-chunk errors (BingX exhibits exactly this).
    const hasLedger =
      (client as unknown as { has?: Record<string, unknown> }).has
        ?.fetchLedger;
    if (
      !hasLedger ||
      hasLedger === "emulated" ||
      typeof (client as unknown as { fetchLedger?: unknown }).fetchLedger
        !== "function"
    ) {
      const msg = `${row.exchange}: fetchLedger not supported by CCXT`;
      await this.repo.markLedgerSyncError(id, msg);
      await this.audit.log({
        actorUserId: userId,
        action: "cex.ledger_sync_unsupported",
        target: id,
        payload: { exchange: row.exchange },
      });
      return { ok: false, newCount: 0, error: msg };
    }

    // Historical backfill: start с latest existing entry + 1ms, или
    // далеко назад (24 months) если первый sync.
    const sinceDate = await this.repo.latestLedgerTimestamp(id);
    const HISTORICAL_BACKFILL_MONTHS = 24;
    const DAY_MS = 86_400_000;
    const sinceMs = sinceDate
      ? sinceDate.getTime() + 1
      : Date.now() - HISTORICAL_BACKFILL_MONTHS * 30 * DAY_MS;
    const untilMs = Date.now();

    // Exchange-specific time range limits (мax window per request).
    // Bitget: max 90d per request (rejects > 90d c "param error time range illegal").
    // Others: попробовать без chunking сначала, fallback на 30d.
    const TIME_WINDOW_MS_PER_EXCHANGE: Partial<Record<string, number>> = {
      bitget: 30 * DAY_MS, // 30 days chunks для safety
      bybit: 7 * DAY_MS, // Bybit обычно 7d max
      okx: 90 * DAY_MS,
      mexc: 30 * DAY_MS,
    };
    const exchangeId = row.exchange as ExchangeId;
    const chunkMs =
      TIME_WINDOW_MS_PER_EXCHANGE[exchangeId] ?? 90 * DAY_MS;

    let newCount = 0;
    const errors: string[] = [];
    const BATCH_LIMIT = 500;
    // Safety cap. 24mo backfill / 7d Bybit chunks = ~104 chunks → set 150
    // чтобы покрыть Bybit полностью даже за 24 месяца. Для Bitget (30d
    // chunks) = ~24 chunks. Hit cap → user видит partial sync, кликает
    // повторно, sync продолжается incremental с last entry.
    const MAX_CHUNKS = 150;
    let chunkStart = sinceMs;
    let chunksProcessed = 0;
    let totalBatches = 0;

    try {
      while (chunkStart < untilMs && chunksProcessed < MAX_CHUNKS) {
        const chunkEnd = Math.min(chunkStart + chunkMs, untilMs);
        // Внутри chunk: пагинация forward по `since`. Пока биржа
        // возвращает entries — продолжаем.
        let currentSince = chunkStart;
        let batchesInChunk = 0;
        const MAX_BATCHES_PER_CHUNK = 20;

        while (
          currentSince < chunkEnd &&
          batchesInChunk < MAX_BATCHES_PER_CHUNK
        ) {
          batchesInChunk++;
          totalBatches++;
          try {
            // Transient-error retry wrapper. CCXT bubbles up undici-level
            // `fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN` etc.
            // when the host briefly times out (network blip / geoblock
            // hiccup / DNS jitter). One retry with backoff turns a hard
            // chunk-failure into a near-invisible delay; without it a
            // single network blip aborts the entire ledger sync.
            const fetchOnce = () =>
              (
                client as unknown as {
                  fetchLedger: (
                    code?: string,
                    since?: number,
                    limit?: number,
                    params?: Record<string, unknown>,
                  ) => Promise<unknown[]>;
                }
              ).fetchLedger(undefined, currentSince, BATCH_LIMIT, {
                endTime: chunkEnd, // some exchanges accept endTime / until
                until: chunkEnd,
              });
            let batch: unknown[];
            try {
              batch = (await fetchOnce()) as unknown[];
            } catch (firstErr) {
              const m = (firstErr as Error).message;
              const transient =
                /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|timeout/i.test(
                  m,
                );
              if (!transient) throw firstErr;
              await new Promise((r) => setTimeout(r, 2_000));
              batch = (await fetchOnce()) as unknown[];
            }

            if (!batch || batch.length === 0) break;

            const normalized = normalizeCcxtLedger(batch);
            const added = await this.repo.upsertLedgerEntries(
              id,
              normalized.map((n) => ({
                ...n,
                executedAt: new Date(n.executedAtMs),
              })),
            );
            newCount += added;

            const maxTs = Math.max(
              ...normalized.map((n) => n.executedAtMs),
              currentSince,
            );
            if (maxTs <= currentSince) break;
            currentSince = maxTs + 1;
            if (batch.length < BATCH_LIMIT) break;
          } catch (e) {
            const msg = (e as Error).message;
            // Hard-stop on "NotSupported" — CCXT throws this when an
            // exchange-specific code-path is missing. Continuing the
            // outer loop would write the same error for every chunk and
            // spam the audit log (see BingX). One concise entry instead.
            if (/not\s*supported/i.test(msg)) {
              errors.push(`${exchangeId}: fetchLedger not supported (${msg.slice(0, 60)})`);
              chunkStart = untilMs; // breaks outer while
              break;
            }
            // Single batch error — record and continue с next chunk.
            errors.push(
              `${exchangeId} ledger chunk ${new Date(chunkStart).toISOString().slice(0, 10)}: ${msg.slice(0, 80)}`,
            );
            break;
          }
        }

        chunkStart = chunkEnd;
        chunksProcessed++;
      }
    } catch (e) {
      errors.push((e as Error).message);
    }

    // Если получили хоть что-то — считаем sync успешным (errors per chunk
    // могут быть API quirks). Только если 0 entries И errors есть → failed.
    const ok = newCount > 0 || errors.length === 0;
    if (ok) {
      await this.repo.markLedgerSyncSuccess(id);
    } else {
      await this.repo.markLedgerSyncError(id, errors.join("; "));
    }
    await this.audit.log({
      actorUserId: userId,
      action: ok ? "cex.ledger_sync" : "cex.ledger_sync_partial",
      target: id,
      payload: {
        newCount,
        chunksProcessed,
        totalBatches,
        ...(errors.length > 0 ? { errors } : {}),
      },
    });
    return {
      ok,
      newCount,
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  }

  async listLedger(id: string, userId: string, limit = 500) {
    const row = await this.repo.findActiveById(id, userId);
    if (!row) throw new NotFoundError(`CEX account ${id} not found.`);
    return this.repo.listLedger(id, limit);
  }
}

/**
 * Bitget's retail tax endpoint logs ONE P2P trade as MULTIPLE journal
 * lines (escrow lock + fee + release, etc.) within a few minutes. The
 * sample from user 9a93d…fd83 on 2026-04-25 had 3 rows (IDs 217666333
 * /609/798) for a single 187 USDT sale.
 *
 * For dashboards we want ONE row per real trade. Heuristic: group raw
 * rows with the same (asset, side) within a 15-minute sliding window,
 * pick the row with the largest amount as canonical (typically the
 * gross trade leg), and tag `mergedCount` so power-users can see the
 * underlying. DB keeps every raw row — dedup is read-time only so a
 * future cost-basis pipeline can still see fees/escrows separately.
 */
const P2P_DEDUP_WINDOW_MS = 15 * 60 * 1000;

export function dedupP2pOrders(
  rows: CexP2pOrderRow[]
): Array<CexP2pOrderRow & { mergedCount: number }> {
  if (rows.length === 0) return [];
  // Group consecutive (in time) rows with same (asset, side) within
  // the sliding window. Input is expected sorted by executed_at DESC
  // (repo guarantees), so iterating once is enough.
  const groups: Array<{
    rows: CexP2pOrderRow[];
    asset: string;
    side: string;
    latestMs: number;
  }> = [];
  for (const r of rows) {
    const ts = r.executedAt.getTime();
    const last = groups[groups.length - 1];
    if (
      last &&
      last.asset === r.asset &&
      last.side === r.side &&
      last.latestMs - ts <= P2P_DEDUP_WINDOW_MS
    ) {
      last.rows.push(r);
      // latestMs stays the max seen — but since rows are DESC, the
      // first row of the group has the latest ts. Keep it.
    } else {
      groups.push({ rows: [r], asset: r.asset, side: r.side, latestMs: ts });
    }
  }
  return groups.map((g) => {
    // Canonical row = the one with the largest amount (most often the
    // principal trade leg; fees/escrow show smaller amounts).
    const canonical = g.rows.reduce((best, cur) =>
      Number(cur.amount) > Number(best.amount) ? cur : best
    );
    return { ...canonical, mergedCount: g.rows.length };
  });
}
