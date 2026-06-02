import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

import {
  PortfolioRefreshProcessor,
  type FlagResolver,
} from "./portfolio-refresh.processor.js";
import type { PortfolioRefreshJobData } from "./portfolio-refresh.queue.js";
import type { PortfolioRefreshService } from "../portfolio/portfolio-refresh.service.js";
import type { AppSettingsService } from "../app-settings/app-settings.service.js";
import type {
  IAccountsRepository,
  OwnerInfo,
} from "../accounts/accounts.repository.js";

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
    getSnapshotSync: vi.fn().mockReturnValue(days),
  } as unknown as AppSettingsService;
}

function makeAccounts(owner: OwnerInfo | null): IAccountsRepository {
  return {
    getOwnerInfo: vi.fn().mockResolvedValue(owner),
  } as unknown as IAccountsRepository;
}

function makeFlags(enabled: boolean): FlagResolver {
  return { enabled: vi.fn().mockResolvedValue(enabled) };
}

const userOwner = (lastLoginAt: Date | null): OwnerInfo => ({
  ownerId: "owner-1",
  role: "user",
  lastLoginAt,
});
const adminOwner = (lastLoginAt: Date | null): OwnerInfo => ({
  ownerId: "admin-1",
  role: "admin",
  lastLoginAt,
});

describe("PortfolioRefreshProcessor — kill-switch (внешние API для не-админов)", () => {
  it("cron + флаг ON + владелец user → ПРОПУСК, refresh не зовётся", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      accounts: makeAccounts(userOwner(new Date())),
      featureFlags: makeFlags(true),
    });
    const res = await proc.process(makeJob("cron"));
    expect(res).toEqual({ skipped: true, reason: "killswitch_non_admin" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cron + флаг ON + владелец admin → рефрешим (админ не затронут)", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      accounts: makeAccounts(adminOwner(new Date())),
      featureFlags: makeFlags(true),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("cron + флаг OFF → рефрешим", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      accounts: makeAccounts(userOwner(new Date())),
      featureFlags: makeFlags(false),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("manual + флаг ON + владелец user → ВСЁ РАВНО рефрешим (ручной не гейтится)", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      accounts: makeAccounts(userOwner(new Date())),
      featureFlags: makeFlags(true),
    });
    await proc.process(makeJob("admin"));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("PortfolioRefreshProcessor — inactivity gate", () => {
  it("cron + неактивный владелец (≥N дней) → пропускаем", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts: makeAccounts(userOwner(new Date(Date.now() - 40 * DAY_MS))),
    });
    const res = await proc.process(makeJob("cron"));
    expect(res).toEqual({ skipped: true, reason: "owner_inactive" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cron + активный владелец (< N дней) → рефрешим", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts: makeAccounts(userOwner(new Date(Date.now() - 5 * DAY_MS))),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("N=0 (выключено) → рефрешим даже давно неактивных", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(0),
      accounts: makeAccounts(userOwner(new Date(Date.now() - 999 * DAY_MS))),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("last_login_at = null → консервативно рефрешим", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts: makeAccounts(userOwner(null)),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("PortfolioRefreshProcessor — без зависимостей", () => {
  it("legacy-конструктор → гейтов нет, рефрешим", async () => {
    const { service, refresh } = makeService();
    const proc = new PortfolioRefreshProcessor(service);
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("ошибка lookup'а владельца → не падаем, рефрешим", async () => {
    const { service, refresh } = makeService();
    const accounts = {
      getOwnerInfo: vi.fn().mockRejectedValue(new Error("db down")),
    } as unknown as IAccountsRepository;
    const proc = new PortfolioRefreshProcessor(service, {
      appSettings: makeSettings(30),
      accounts,
      featureFlags: makeFlags(true),
    });
    await proc.process(makeJob("cron"));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
