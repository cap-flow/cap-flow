import { generateInviteToken, hashToken } from "../auth/tokens.js";
import type { AuditService } from "../audit/audit.service.js";

import type { TelegramRepository, TelegramLinkRow } from "./telegram.repository.js";
import type { TelegramProxyState } from "./telegram.proxy.js";

export interface TelegramServiceConfig {
  /**
   * Live getter for the bot username. Called on every `startLink()` so
   * admin PATCH on `/admin/integrations/telegram` takes effect without
   * a restart (admin setSecret() mutates process.env and the wiring in
   * app.ts reads from process.env first, then the boot-time env value).
   */
  readonly getBotUsername: () => string | undefined;
  /**
   * Live getter for the bot API token. Same hot-reload rationale as
   * `getBotUsername`. Returning undefined makes `send()` no-op.
   */
  readonly getBotApiToken: () => string | undefined;
  readonly linkTtlMinutes: number;
}

export interface StartLinkResult {
  readonly code: string;
  /** Empty when `botUsername` not configured — frontend should show the code as-is. */
  readonly deepLink: string;
  readonly expiresAt: Date;
}

/**
 * Telegram integration — link tokens + outgoing messages.
 *
 * **Phase 7 ships only the link-token half.** Outgoing `send` is gated by
 * having a `linked` row for the user; if the bot host isn't decided yet
 * (`botApiToken` empty) we no-op cleanly and the audit row reads
 * `telegram_skipped`. Phase 7b wires up the actual bot — both webhook and
 * outgoing HTTP — without touching this service's call sites.
 */
export class TelegramService {
  /**
   * Optional. Attached via `attachProxyState()` after construction so
   * the service can be wired up before `AdminIntegrationsService` is
   * available. When set, `send()` routes through the cached undici
   * dispatcher so api.telegram.org is reachable from geo-blocked
   * regions. Hot-reloaded by admin PATCH on `telegram_proxy`.
   */
  private proxyState: TelegramProxyState | null = null;

  constructor(
    private readonly repo: TelegramRepository,
    private readonly audit: AuditService,
    private readonly cfg: TelegramServiceConfig
  ) {}

  attachProxyState(state: TelegramProxyState): void {
    this.proxyState = state;
  }

  /**
   * Issue (or reuse) a one-time `/start` code. Returns the raw code +
   * (when bot username is set) a deep-link the frontend can wrap in a
   * button. The code is shown once, then only its hash lives in the DB.
   */
  async startLink(userId: string): Promise<StartLinkResult> {
    // If a pending row already exists and is fresh, reuse it — the user
    // probably clicked "Connect Telegram" twice. Otherwise issue a new one.
    const pending = await this.repo.findPendingByUser(userId);
    const now = Date.now();
    if (pending && pending.expiresAt.getTime() > now) {
      // We don't store the raw code so we can't re-emit it. Force re-issue
      // by revoking the stale row and creating a new pending. (Comment
      // for the future maintainer: if we ever want true "reuse the code",
      // we'd need to keep it encrypted at rest; not worth it.)
      await this.repo.revoke(userId);
    } else if (pending) {
      await this.repo.revoke(userId);
    }

    const code = generateInviteToken();
    const hash = hashToken(code);
    const expiresAt = new Date(now + this.cfg.linkTtlMinutes * 60 * 1000);
    await this.repo.createPending({
      userId,
      startCodeHash: hash,
      expiresAt,
    });
    await this.audit.log({
      actorUserId: userId,
      action: "telegram.link_started",
      payload: { expiresAt: expiresAt.toISOString() },
    });

    const username = this.cfg.getBotUsername()?.trim() ?? "";
    const deepLink = username
      ? `https://t.me/${username}?start=${code}`
      : "";
    return { code, deepLink, expiresAt };
  }

  async status(userId: string): Promise<{
    state: "linked" | "pending" | "none";
    chatId: number | null;
    telegramUsername: string | null;
    linkedAt: Date | null;
  }> {
    const linked = await this.repo.findActiveByUser(userId);
    if (linked) {
      return {
        state: "linked",
        chatId: linked.chatId,
        telegramUsername: linked.telegramUsername,
        linkedAt: linked.linkedAt,
      };
    }
    const pending = await this.repo.findPendingByUser(userId);
    if (pending) {
      return {
        state: "pending",
        chatId: null,
        telegramUsername: null,
        linkedAt: null,
      };
    }
    return { state: "none", chatId: null, telegramUsername: null, linkedAt: null };
  }

  async unlink(userId: string): Promise<number> {
    const n = await this.repo.revoke(userId);
    if (n > 0) {
      await this.audit.log({
        actorUserId: userId,
        action: "telegram.unlinked",
        payload: { revoked: n },
      });
    }
    return n;
  }

  /**
   * Send a plain-text message. No-op (returns false) if the user hasn't
   * linked their account, or if the bot API token isn't configured.
   *
   * Returns `true` only on a successful HTTP send.
   */
  async send(userId: string, text: string): Promise<boolean> {
    const link = await this.repo.findActiveByUser(userId);
    if (!link || link.chatId === null) return false;
    const botApiToken = this.cfg.getBotApiToken()?.trim();
    if (!botApiToken) return false;

    const proxy = this.proxyState?.currentSync() ?? null;
    // undici-specific `dispatcher` field is missing from the standard
    // RequestInit type — cast via unknown so TS accepts it. Native fetch
    // in Node ignores unknown fields, so omitting is also safe.
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: link.chatId,
        text,
        parse_mode: "Markdown",
      }),
      ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
    } as unknown as RequestInit;
    const res = await fetch(
      `https://api.telegram.org/bot${botApiToken}/sendMessage`,
      init,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw new Error(
        `Telegram send failed: ${res.status} — ${body.slice(0, 200)}`
      );
    }
    return true;
  }

  /**
   * Called by the bot listener (Phase 7b) when `/start <code>` lands.
   * Idempotent: re-running with the same code on an already-linked row
   * does nothing destructive.
   */
  async completeLink(args: {
    rawCode: string;
    chatId: number;
    telegramUsername: string | null;
  }): Promise<TelegramLinkRow | null> {
    const link = await this.repo.findByStartCode(hashToken(args.rawCode));
    if (!link || link.status !== "pending") return null;
    if (link.expiresAt.getTime() < Date.now()) return null;
    await this.repo.markLinked(
      link.id,
      args.chatId,
      args.telegramUsername
    );
    await this.audit.log({
      actorUserId: link.userId,
      action: "telegram.linked",
      payload: { chatId: args.chatId },
    });
    return link;
  }
}
