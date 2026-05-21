/**
 * Long-polling worker for the Telegram Bot API.
 *
 * Why polling instead of webhook: Russia's TSPU (DPI) and / or hosting
 * provider firewalls drop incoming TCP from Telegram's data-centre IP
 * ranges (149.154.160.0/20 etc.) to RU IPs, even when outgoing
 * connections from the same RU IP to api.telegram.org succeed (we
 * already proved this via our SOCKS5 dispatcher). Webhook is therefore
 * unusable; long-polling reverses the direction and works.
 *
 * Operational model:
 *   - Single instance owns the poll loop (Telegram returns 409 if two
 *     getUpdates calls overlap). We currently run one API replica, so
 *     this is fine.
 *   - Offset is kept in memory. Telegram queues unread updates for 24h,
 *     so a restart picks up anything missed. On first start (offset=0)
 *     we explicitly call `?offset=-1` first to skip the backlog if any
 *     left over from a previous webhook run (otherwise we'd re-process
 *     them all and spam users).
 *   - Network hiccup → log + sleep 5s + retry. We never throw out of
 *     the loop.
 *   - `stop()` flips a flag and aborts the in-flight long-poll. Used on
 *     SIGTERM via the Fastify onClose hook.
 *
 * The poll loop is enabled by `TELEGRAM_BOT_USE_POLLING=true`. When
 * disabled we still expose `processUpdateOnce` (used by webhook path).
 */
import type { FastifyBaseLogger } from "fastify";
import { fetch as undiciFetch } from "undici";

import type { TelegramProxyState } from "./telegram.proxy.js";
import type { TelegramService } from "./telegram.service.js";
import {
  processTelegramUpdate,
  telegramUpdateSchema,
  type TelegramUpdate,
} from "./telegram.webhook.routes.js";

export interface TelegramPollerOptions {
  readonly getBotApiToken: () => string | undefined;
  readonly proxyState: TelegramProxyState;
  readonly telegram: TelegramService;
  readonly log: FastifyBaseLogger;
  /**
   * Optional: signup-сервис для обработки `/start s_<nonce>` flow.
   * Без него такие коды получают friendly "сервис недоступен".
   */
  readonly signup?: import("../auth-telegram-signup/signup.service.js").TelegramSignupService;
  /**
   * Long-poll timeout (seconds) — Telegram holds the connection open
   * up to this long if no update is ready. Server-side cap is 50s; we
   * use 25s as a safe default that survives most NAT keepalives.
   */
  readonly longPollTimeoutSec?: number;
}

export class TelegramPoller {
  private offset = 0;
  private running = false;
  private aborter: AbortController | null = null;
  private skippedBacklog = false;

  constructor(private readonly opts: TelegramPollerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.aborter?.abort();
  }

  private async loop(): Promise<void> {
    const timeoutSec = this.opts.longPollTimeoutSec ?? 25;
    while (this.running) {
      const token = this.opts.getBotApiToken()?.trim();
      if (!token) {
        // No token configured (yet). Sleep and retry — admin may set
        // it via the integrations UI without restarting.
        await sleep(30_000, () => !this.running);
        continue;
      }
      try {
        // First iteration: skip whatever's queued from previous webhook
        // run by passing offset=-1 + limit=1 to consume one update,
        // then commit offset to (that.update_id + 1). Without this we'd
        // re-process all backlog and resend «✅ Готово» / «❌ Код истёк»
        // for every old /start.
        if (!this.skippedBacklog) {
          await this.skipBacklog(token);
          this.skippedBacklog = true;
          continue;
        }
        const updates = await this.fetchUpdates(token, timeoutSec);
        for (const u of updates) {
          try {
            await processTelegramUpdate(u, {
              telegram: this.opts.telegram,
              ...(this.opts.signup ? { signup: this.opts.signup } : {}),
            });
          } catch (e) {
            this.opts.log.error(
              { err: (e as Error).message, update_id: u.update_id },
              "[telegram-poller] processUpdate failed — skipping",
            );
          }
          if (typeof u.update_id === "number") {
            this.offset = Math.max(this.offset, u.update_id + 1);
          }
        }
      } catch (e) {
        // Network error / Telegram 5xx / proxy down etc. — log, brief
        // backoff, continue. Never throw out of the loop.
        this.opts.log.warn(
          { err: (e as Error).message },
          "[telegram-poller] getUpdates failed — retrying in 5s",
        );
        await sleep(5_000, () => !this.running);
      }
    }
  }

  private async fetchUpdates(
    token: string,
    timeoutSec: number,
  ): Promise<TelegramUpdate[]> {
    const proxy = this.opts.proxyState.currentSync();
    this.aborter = new AbortController();
    const url = new URL(
      `https://api.telegram.org/bot${token}/getUpdates`,
    );
    url.searchParams.set("timeout", String(timeoutSec));
    url.searchParams.set("offset", String(this.offset));
    // Webhook updates only — keep parity with setWebhook config.
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

    const res = await undiciFetch(url.toString(), {
      method: "GET",
      signal: this.aborter.signal,
      ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
    });
    if (!res.ok) {
      // 409 means a webhook is still registered — surface clearly.
      const body = await res.text().catch(() => "<no body>");
      throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      ok: boolean;
      result?: unknown[];
      description?: string;
    };
    if (!json.ok || !Array.isArray(json.result)) {
      throw new Error(`Telegram not-ok: ${json.description ?? "<no desc>"}`);
    }
    const out: TelegramUpdate[] = [];
    for (const raw of json.result) {
      const parsed = telegramUpdateSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  private async skipBacklog(token: string): Promise<void> {
    const proxy = this.opts.proxyState.currentSync();
    const url = new URL(
      `https://api.telegram.org/bot${token}/getUpdates`,
    );
    // offset=-1 returns the LAST queued update only; we use it to
    // advance our offset past everything in the backlog.
    url.searchParams.set("offset", "-1");
    url.searchParams.set("limit", "1");
    url.searchParams.set("timeout", "0");
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
    const res = await undiciFetch(url.toString(), {
      method: "GET",
      ...(proxy?.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Telegram HTTP ${res.status} during backlog skip: ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as {
      ok: boolean;
      result?: Array<{ update_id?: number }>;
    };
    const last = json.result?.[0];
    if (last && typeof last.update_id === "number") {
      // Advance offset past this update so it WILL be processed by the
      // first real fetchUpdates call (we WANT artur's pending /start
      // to be delivered, not skipped). Use `last.update_id` (not +1) —
      // first real poll uses offset=last.update_id and the message is
      // re-emitted (Telegram considers it unacked until offset > id).
      this.offset = last.update_id;
      this.opts.log.info(
        { offset: this.offset },
        "[telegram-poller] backlog detected — first poll will start here",
      );
    } else {
      this.opts.log.info(
        "[telegram-poller] no backlog — starting from offset=0",
      );
    }
  }
}

async function sleep(ms: number, abortIf: () => boolean): Promise<void> {
  // Sleep in 200ms chunks so we wake quickly on stop().
  const tick = 200;
  let left = ms;
  while (left > 0 && !abortIf()) {
    await new Promise((r) => setTimeout(r, Math.min(tick, left)));
    left -= tick;
  }
}
