import type { Job } from "bullmq";

import type { IAccountsRepository } from "../accounts/accounts.repository.js";
import type { AppSettingsService } from "../app-settings/app-settings.service.js";
import type { PortfolioRefreshService } from "../portfolio/portfolio-refresh.service.js";

import type { PortfolioRefreshJobData } from "./portfolio-refresh.queue.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PortfolioRefreshProcessorDeps {
  /** Live-настройки (для knob `portfolio.refreshSkipInactiveDays`). */
  readonly appSettings?: AppSettingsService;
  /** Для lookup'а last-login владельца аккаунта. */
  readonly accounts?: IAccountsRepository;
  /** Опциональный логгер (skip-события). */
  readonly logger?: { info: (obj: unknown, msg: string) => void };
}

/**
 * BullMQ job processor for `portfolio-refresh`.
 *
 * Тонкая обёртка над `PortfolioRefreshService`. Дополнительно: для CRON-задач
 * пропускает аккаунты, чьи владельцы давно не заходили (knob
 * `portfolio.refreshSkipInactiveDays`, 0 = выкл.), чтобы не жечь DeBank-кредиты
 * на дормантных юзерах. Ручной рефреш (admin/user) НЕ гейтится. Зависимости
 * опциональны — без них (и в тестах) поведение прежнее.
 */
export class PortfolioRefreshProcessor {
  private readonly appSettings: AppSettingsService | undefined;
  private readonly accounts: IAccountsRepository | undefined;
  private readonly logger: PortfolioRefreshProcessorDeps["logger"] | undefined;

  constructor(
    private readonly service: PortfolioRefreshService,
    deps: PortfolioRefreshProcessorDeps = {},
  ) {
    this.appSettings = deps.appSettings;
    this.accounts = deps.accounts;
    this.logger = deps.logger;
  }

  async process(job: Job<PortfolioRefreshJobData>): Promise<unknown> {
    const data = job.data;
    // The queue's trigger union is "cron" | "admin" | "user"; the service
    // collapses the two manual flavours into a single audit action.
    const trigger: "cron" | "manual" = data.trigger === "cron" ? "cron" : "manual";

    // Inactivity gate — ТОЛЬКО для cron. Ручной рефреш всегда исполняется.
    if (trigger === "cron" && (await this.shouldSkipInactive(data.accountId))) {
      this.logger?.info(
        { accountId: data.accountId },
        "[worker] refresh skipped — owner inactive",
      );
      return { skipped: true, reason: "owner_inactive" };
    }

    return this.service.refreshAccount({
      accountId: data.accountId,
      trigger,
      actorUserId: data.actorUserId ?? null,
    });
  }

  /**
   * true, если владелец аккаунта не заходил ≥ N дней (N = knob, >0).
   * Консервативно: при N=0 (выкл), отсутствии зависимостей, ошибке lookup'а
   * или `last_login_at IS NULL` (ни разу не заходил) — НЕ пропускаем (рефрешим).
   */
  private async shouldSkipInactive(accountId: string): Promise<boolean> {
    if (!this.appSettings || !this.accounts) return false;
    let days: number;
    try {
      days = await this.appSettings.getNumber("portfolio.refreshSkipInactiveDays");
    } catch {
      return false;
    }
    if (!Number.isFinite(days) || days <= 0) return false;

    let lastLoginAt: Date | null | undefined;
    try {
      lastLoginAt = await this.accounts.getOwnerLastLoginAt(accountId);
    } catch {
      return false; // не смогли узнать — рефрешим (безопаснее)
    }
    // null = ни разу не логинился, undefined = аккаунт не найден → не скипаем.
    if (lastLoginAt == null) return false;

    const ageMs = Date.now() - lastLoginAt.getTime();
    return ageMs >= days * DAY_MS;
  }
}
