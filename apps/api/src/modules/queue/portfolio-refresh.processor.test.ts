import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

import { PortfolioRefreshProcessor } from "./portfolio-refresh.processor.js";
import type { PortfolioRefreshJobData } from "./portfolio-refresh.queue.js";
import type { PortfolioRefreshService } from "../portfolio/portfolio-refresh.service.js";
import type { AppSettingsService } from "../app-settings/app-settings.service.js";
import type { IAccountsRepository } from "../accounts/accounts.repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeJob(
  trigger: PortfolioRefreshJobData["trigger"],
  accountId = "acc-1",
): Job<PortfolioRefreshJobData> {
  return { data: { accountId, trigger } } as Job<PortfolioRefreshJobData>;
}

function makeService(): {
  service: PortfolioRefreshService;
  refresh: ReturnType<typeof vi.fn>;
} {
  const refresh = vi.fn().mockResolvedValue({ snapshotId: "s1" });
  const service = { refreshAccount: refresh } as unknown as PortfolioRefreshService;
  return { service, refresh };
}

function makeSettings(days: number): AppSettingsService {
  return {
    getNumber: vi.fn().mockResolvedValue(days),
  } as unknown as AppSettingsService;
}

function makeAccounts(lastLoginAt: Date | null | undefined): IAccountsRepository {
  return {
    getOwnerLastLoginAt: vi.fn().mockResolvedValue(lastLoginAt),
  } as unknown as IAccountsRepository;
}

describe("PortfolioRefreshProcessor — inactivity gate", () => {
  it("cron + неактивный владелец (≥N дней) → пропускаем, refreshAccount НЕ зовётся", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts: makeAccounts(new Date(Date.now() - 40 * DAY_MS)),
    });
    const res = await proc.process(makeJob("cron"));
    expect(res).toEqual({ skipped: true, reason: "owner_inactive" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cron + активный владелец (< N дней) → рефрешим", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts: makeAccounts(new Date(Date.now() - 5 * DAY_MS)),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("manual (admin) + неактивный → ВСЁ РАВНО рефрешим (ручной не гейтится)", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts: makeAccounts(new Date(Date.now() - 100 * DAY_MS)),
    });
    await proc.process(makeJob("admin"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("N=0 (выключено) → рефрешим всех, даже давно неактивных", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(0),
      accounts: makeAccounts(new Date(Date.now() - 999 * DAY_MS)),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("last_login_at = null (ни разу не заходил) → консервативно рефрешим", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts: makeAccounts(null),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("без зависимостей (legacy-конструктор) → гейта нет, рефрешим", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service);
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("ошибка lookup'а last-login → не падаем, рефрешим (безопаснее)", async () => {
    const { service, refresh } = makeService();
    const accounts = {
      getOwnerLastLoginAt: vi.fn().mockRejectedValue(new Error("db down")),
    } as unknown as IAccountsRepository;
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts,
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
