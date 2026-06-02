import type { Job } from "bullmq";

import type {
  IAccountsRepository,
  OwnerInfo,
} from "../accounts/accounts.repository.js";
import type { AppSettingsService } from "../app-settings/app-settings.service.js";
import type { PortfolioRefreshService } from "../portfolio/portfolio-refresh.service.js";

import type { PortfolioRefreshJobData } from "./portfolio-refresh.queue.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Kill-switch flag (тот же, что гейтит upstream-proxy в
 * `upstream-proxy.routes.ts`). При Global ON серверный cron тоже НЕ рефрешит
 * портфели не-админов — иначе воркер продолжал бы жечь DeBank-кредиты на
 * автообновлении, даже когда юзеры заблокированы на browser-пути.
 */
const BLOCK_NON_ADMIN_FLAG = "capflow.feature.blockUpstreamApiForNonAdmins";

/** Минимальный резолвер флагов (FeatureFlagsService ему удовлетворяет). */
export interface FlagResolver {
  enabled(
    key: string,
    ctx: { userId?: string | null; accountId?: string | null },
  ): Promise<boolean>;
}

export interface PortfolioRefreshProcessorDeps {
  /** Live-настройки (для knob `portfolio.refreshSkipInactiveDays`). */
  readonly appSettings?: AppSettingsService;
  /** Для lookup'а владельца аккаунта (роль + last-login). */
  readonly accounts?: IAccountsRepository;
  /** Резолвер feature-flags (kill-switch внешних API для не-админов). */
  readonly featureFlags?: FlagResolver;
  /** Опциональный логгер (skip-события). */
  readonly logger?: { info: (obj: unknown, msg: string) => void };
}

/**
 * BullMQ job processor for `portfolio-refresh`.
 *
 * Тонкая обёртка над `PortfolioRefreshService`. Для CRON-задач применяет два
 * гейта (ручной рефреш admin/user НЕ гейтится никогда):
 *   1. **Kill-switch**: если флаг `BLOCK_NON_ADMIN_FLAG` включён (global/
 *      per-user владельца) и владелец — не админ → пропуск. Это закрывает
 *      серверный путь трат (воркер дёргает DeBank напрямую, мимо upstream-
 *      proxy, поэтому browser-гейт его не покрывал).
 *   2. **Inactivity**: владелец не заходил ≥ N дней (knob
 *      `portfolio.refreshSkipInactiveDays`, 0 = выкл).
 * Зависимости опциональны — без них (и в тестах) поведение прежнее.
 */
export class PortfolioRefreshProcessor {
  private readonly appSettings: AppSettingsService | undefined;
  private readonly accounts: IAccountsRepository | undefined;
  private readonly featureFlags: FlagResolver | undefined;
  private readonly logger: PortfolioRefreshProcessorDeps["logger"] | undefined;

  constructor(
    private readonly service: PortfolioRefreshService,
    deps: PortfolioRefreshProcessorDeps = {},
  ) {
    this.appSettings = deps.appSettings;
    this.accounts = deps.accounts;
    this.featureFlags = deps.featureFlags;
    this.logger = deps.logger;
  }

  async process(job: Job<PortfolioRefreshJobData>): Promise<unknown> {
    const data = job.data;
    // The queue's trigger union is "cron" | "admin" | "user"; the service
    // collapses the two manual flavours into a single audit action.
    const trigger: "cron" | "manual" = data.trigger === "cron" ? "cron" : "manual";

    // Гейты — ТОЛЬКО для cron. Ручной рефреш (admin/user) всегда исполняется.
    if (trigger === "cron") {
      // Владельца тянем один раз для обоих гейтов.
      const owner = this.accounts
        ? await this.accounts.getOwnerInfo(data.accountId).catch(() => null)
        : null;

      // 1. Kill-switch: внешние API отключены для не-админов.
      if (await this.blockedByKillSwitch(owner)) {
        this.logger?.info(
          { accountId: data.accountId },
          "[worker] refresh skipped — kill-switch (non-admin)",
        );
        return { skipped: true, reason: "killswitch_non_admin" };
      }

      // 2. Неактивный владелец.
      if (this.shouldSkipInactive(owner)) {
        this.logger?.info(
          { accountId: data.accountId },
          "[worker] refresh skipped — owner inactive",
        );
        return { skipped: true, reason: "owner_inactive" };
      }
    }

    return this.service.refreshAccount({
      accountId: data.accountId,
      trigger,
      actorUserId: data.actorUserId ?? null,
    });
  }

  /**
   * true, если kill-switch включён для владельца и владелец — не админ.
   * Админские аккаунты продолжают рефрешиться. Fail-open: нет резолвера/
   * владельца/ошибка → не блокируем.
   */
  private async blockedByKillSwitch(owner: OwnerInfo | null): Promise<boolean> {
    if (!this.featureFlags || !owner) return false;
    if (owner.role === "admin") return false; // админ не затронут
    try {
      return await this.featureFlags.enabled(BLOCK_NON_ADMIN_FLAG, {
        userId: owner.ownerId,
      });
    } catch {
      return false;
    }
  }

  /**
   * true, если владелец не заходил ≥ N дней (N = knob, >0).
   * Консервативно: N=0 (выкл) / нет зависимостей / нет владельца /
   * `last_login_at IS NULL` → НЕ пропускаем (рефрешим).
   */
  private shouldSkipInactive(owner: OwnerInfo | null): boolean {
    if (!this.appSettings || !owner) return false;
    let days: number;
    try {
      days = this.appSettings.getSnapshotSync<number>(
        "portfolio.refreshSkipInactiveDays",
      );
    } catch {
      return false;
    }
    if (!Number.isFinite(days) || days <= 0) return false;
    if (owner.lastLoginAt == null) return false;
    const ageMs = Date.now() - owner.lastLoginAt.getTime();
    return ageMs >= days * DAY_MS;
  }
}
