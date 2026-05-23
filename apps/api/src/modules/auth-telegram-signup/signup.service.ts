/**
 * Telegram-signup auth flow.
 *
 * High-level: anonymous пользователь жмёт «Войти через Telegram» на
 * странице /login. Сервер генерит one-shot nonce, отдаёт ссылку на
 * бота. В боте /start → бот привязывает Telegram identity к nonce,
 * шлёт пользователю ссылку обратно на сайт. /finish → cookie + redirect.
 *
 * Зачем НЕ Telegram Login Widget: его OAuth callback требует, чтобы
 * `api.telegram.org` мог достучаться до нашего endpoint. RU TSPU
 * блокирует входящие от Telegram-DC к российским IP (тот же баг, из-за
 * которого мы перешли на long-polling). Поэтому bot-deeplink flow —
 * единственный вариант.
 *
 * См. migration 0022 и `signup.repository.ts` для DB-сторонней схемы.
 */
import { createHash, randomBytes } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { AuditService } from "../audit/audit.service.js";
import type { UserRow } from "../auth/auth.repository.js";
import { hashPassword } from "../auth/password.js";

import type { ITelegramSignupRepository } from "./signup.repository.js";

export interface TelegramSignupConfig {
  /** Канонический origin для ссылки в чате. Без trailing slash. */
  readonly siteOrigin: string;
  /** Сколько живёт nonce от issue до consume. */
  readonly nonceTtlMinutes: number;
}

export interface StartSignupResult {
  /** Raw nonce — отдаётся клиенту разово; на сервере хранится только sha256-hash. */
  readonly rawNonce: string;
  /** Полный deep-link для open'а в браузере / новой вкладке. */
  readonly botDeepLink: string;
}

export interface BotStartHandlePayload {
  readonly rawNonce: string;
  readonly telegramUserId: number;
  readonly telegramChatId: number;
  readonly telegramUsername: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
}

export interface BotStartHandleResult {
  /** Ссылка на сайт для входа — бот отправит её в чат пользователю. */
  readonly finishUrl: string;
  /** Создан ли новый user (для дружелюбного сообщения). */
  readonly createdNewUser: boolean;
  /**
   * Task #43: для новых пользователей бот провижнит начальные login + password
   * и отправит их в welcome-DM. Сохраняем plaintext только в этом transient
   * объекте — в БД лежит только argon2 hash.
   * `null` для returning users или если provisioning не удался (collision, etc.).
   */
  readonly initialCredentials: {
    readonly username: string;
    readonly password: string;
  } | null;
}

export type FinishLoginOutcome =
  | { kind: "ok"; user: UserRow; needsPasswordSetup: boolean }
  | { kind: "gone" }; // nonce уже consumed / expired / без user_id

export class TelegramSignupService {
  constructor(
    private readonly repo: ITelegramSignupRepository,
    private readonly audit: AuditService,
    private readonly cfg: TelegramSignupConfig,
    private readonly log: FastifyBaseLogger,
    private readonly getBotUsername: () => string | undefined,
  ) {}

  /**
   * Шаг 1: anonymous POST с /login.
   *
   * Возвращает raw nonce → клиент НЕ хранит его; сразу открывает
   * `botDeepLink` в новой вкладке. Если юзер уходит / закрывает —
   * nonce истечёт через `nonceTtlMinutes` и будет cleaned.
   */
  async startSignup(): Promise<StartSignupResult> {
    const raw = randomBytes(24).toString("base64url"); // 32-char URL-safe
    const nonceHash = sha256Hex(raw);
    const expiresAt = new Date(
      Date.now() + this.cfg.nonceTtlMinutes * 60 * 1000,
    );
    await this.repo.createNonce({ nonceHash, expiresAt });
    const botUsername = this.getBotUsername()?.trim();
    if (!botUsername) {
      throw new Error(
        "TELEGRAM_BOT_USERNAME не задан — кнопка «Войти через Telegram» не должна была вызвать start-signup. Проверьте /admin/integrations.",
      );
    }
    const botDeepLink = `https://t.me/${botUsername}?start=s_${raw}`;
    return { rawNonce: raw, botDeepLink };
  }

  /**
   * Task #47: same as startSignup, но с `r_<nonce>` payload → бот видит
   * сигнатуру reset-flow → перезаписывает password (или регистрирует, если
   * новый user). Endpoint защищён rate-limit, чтобы избежать abuse.
   */
  async startReset(): Promise<StartSignupResult> {
    const raw = randomBytes(24).toString("base64url");
    const nonceHash = sha256Hex(raw);
    const expiresAt = new Date(
      Date.now() + this.cfg.nonceTtlMinutes * 60 * 1000,
    );
    await this.repo.createNonce({ nonceHash, expiresAt });
    const botUsername = this.getBotUsername()?.trim();
    if (!botUsername) {
      throw new Error(
        "TELEGRAM_BOT_USERNAME не задан — нельзя выпустить reset-link.",
      );
    }
    const botDeepLink = `https://t.me/${botUsername}?start=r_${raw}`;
    return { rawNonce: raw, botDeepLink };
  }

  /**
   * Шаг 2: бот получил /start с code `s_<raw>`.
   *
   * Распознаём в `processTelegramUpdate` через `parseSignupStartCode`
   * ниже. Caller передаёт raw nonce и идентификацию из Telegram update.
   *
   * Поведение:
   *   - nonce expired / не найден → throw → бот ответит «Ссылка устарела…»
   *   - users.findByTelegramId(from.id) ?? createTelegramUser(...)
   *   - bindNonceToUser
   *   - возвращает finishUrl для отправки в чат
   */
  async handleBotStart(
    payload: BotStartHandlePayload,
  ): Promise<BotStartHandleResult> {
    const nonceHash = sha256Hex(payload.rawNonce);
    const row = await this.repo.findNonce(nonceHash);
    if (!row) {
      throw new SignupNonceError("not_found");
    }
    if (row.consumedAt) {
      throw new SignupNonceError("already_consumed");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new SignupNonceError("expired");
    }
    if (row.userId) {
      // Кто-то уже привязал user'а к этому nonce — возможна повторная
      // /start или race. Если же тот же Telegram user — продолжаем
      // (idempotent), иначе reject.
      if (row.telegramUserId !== payload.telegramUserId) {
        throw new SignupNonceError("conflict");
      }
      return {
        finishUrl: this.buildFinishUrl(payload.rawNonce),
        createdNewUser: false,
        initialCredentials: null,
      };
    }

    const existing = await this.repo.findUserByTelegramId(
      payload.telegramUserId,
    );
    let user: UserRow;
    let createdNewUser: boolean;
    if (existing) {
      user = existing;
      createdNewUser = false;
    } else {
      user = await this.repo.createTelegramUser({
        telegramUserId: payload.telegramUserId,
        telegramUsername: payload.telegramUsername,
        firstName: payload.firstName,
        lastName: payload.lastName,
        telegramChatId: payload.telegramChatId,
      });
      createdNewUser = true;
      await this.audit.log({
        actorUserId: user.id,
        action: "auth.telegram_signup_created",
        payload: {
          telegramUserId: payload.telegramUserId,
          telegramUsername: payload.telegramUsername,
        },
      });
    }

    // Idempotent backfill: гарантируем что у юзера есть Main account
    // + linked telegram_links. Нужно для returning users, у которых
    // предыдущий signup-flow (до этого фикса) не успел провижнуть
    // — иначе они зависают в UI без портфеля и без видимой Telegram-привязки.
    await this.repo.ensureUserDefaults({
      userId: user.id,
      telegramChatId: payload.telegramChatId,
      telegramUsername: payload.telegramUsername,
    });

    await this.repo.bindNonceToUser({
      nonceHash,
      userId: user.id,
      telegramUserId: payload.telegramUserId,
      telegramChatId: payload.telegramChatId,
      telegramUsername: payload.telegramUsername,
    });

    // Task #43: для новых пользователей провижним username + password
    // автоматически, чтобы welcome-DM содержал готовые login-данные.
    // Returning users (createdNewUser=false) уже имеют свои creds —
    // не трогаем.
    let initialCredentials: { username: string; password: string } | null = null;
    if (createdNewUser && !user.passwordHash) {
      try {
        initialCredentials = await this.provisionInitialCredentials({
          userId: user.id,
          telegramUsername: payload.telegramUsername,
          telegramUserId: payload.telegramUserId,
        });
      } catch (err) {
        // Provisioning fail (UNIQUE conflict на username, etc.) — не блокируем
        // login flow. Пользователь сможет вручную задать creds через
        // /auth/set-password на следующем шаге.
        this.log.warn(
          { err, userId: user.id },
          "[telegram-signup] auto-provision creds failed — fallback to manual set-password",
        );
      }
    }

    return {
      finishUrl: this.buildFinishUrl(payload.rawNonce),
      createdNewUser,
      initialCredentials,
    };
  }

  /**
   * Task #43: генерирует initial username + password для нового
   * Telegram-signup пользователя. Сохраняет hash в БД, возвращает
   * plaintext password (для отправки в welcome-DM).
   *
   * Username derivation:
   *   1. telegramUsername (если есть и не занят)
   *   2. `tg_<telegramUserId>` (если телеграм-username нет или занят)
   *   3. + `_<random>` если оба заняты (UNIQUE conflict fallback)
   *
   * Password: 16 cryptographically-random chars (base64url, ~96 bit entropy).
   */
  private async provisionInitialCredentials(args: {
    userId: string;
    telegramUsername: string | null;
    telegramUserId: number;
  }): Promise<{ username: string; password: string }> {
    const password = randomBytes(12).toString("base64url"); // ~16 chars
    const passwordHash = await hashPassword(password);
    const candidates: string[] = [];
    if (args.telegramUsername) candidates.push(args.telegramUsername);
    candidates.push(`tg_${args.telegramUserId}`);
    // Final fallback с rand-suffix (если оба заняты)
    candidates.push(
      `tg_${args.telegramUserId}_${randomBytes(2).toString("hex")}`,
    );

    let lastErr: unknown = null;
    for (const username of candidates) {
      try {
        await this.repo.setInitialPasswordAndUsername(
          args.userId,
          passwordHash,
          username,
        );
        await this.audit.log({
          actorUserId: args.userId,
          action: "auth.telegram_signup_auto_provisioned",
          payload: { username },
        });
        return { username, password };
      } catch (e) {
        lastErr = e;
        // UNIQUE conflict на username → пробуем следующего кандидата
        continue;
      }
    }
    throw new Error(
      `provisionInitialCredentials: all candidates conflicted: ${String(lastErr)}`,
    );
  }

  /**
   * Task #45: bare `/start` (no payload) handler. User жмёт START в боте
   * напрямую (не через website signup-flow). Поведение:
   *   - new user → register + auto-provision creds + fresh finish-link
   *   - existing user → fresh finish-link (без creds) для one-click login
   *
   * Внутри: создаёт fresh nonce и сразу binds его к user'у (skipping
   * website's start-signup step). User получает же финиш-link, что и
   * через обычный signup-flow.
   */
  async handleBareBotStart(payload: {
    telegramUserId: number;
    telegramChatId: number;
    telegramUsername: string | null;
    firstName: string | null;
    lastName: string | null;
  }): Promise<BotStartHandleResult> {
    const raw = randomBytes(24).toString("base64url");
    const nonceHash = sha256Hex(raw);
    const expiresAt = new Date(
      Date.now() + this.cfg.nonceTtlMinutes * 60 * 1000,
    );
    await this.repo.createNonce({ nonceHash, expiresAt });

    const existing = await this.repo.findUserByTelegramId(payload.telegramUserId);
    let user: UserRow;
    let createdNewUser: boolean;
    if (existing) {
      user = existing;
      createdNewUser = false;
    } else {
      user = await this.repo.createTelegramUser({
        telegramUserId: payload.telegramUserId,
        telegramUsername: payload.telegramUsername,
        firstName: payload.firstName,
        lastName: payload.lastName,
        telegramChatId: payload.telegramChatId,
      });
      createdNewUser = true;
      await this.audit.log({
        actorUserId: user.id,
        action: "auth.telegram_bare_start_created",
        payload: {
          telegramUserId: payload.telegramUserId,
          telegramUsername: payload.telegramUsername,
        },
      });
    }

    await this.repo.ensureUserDefaults({
      userId: user.id,
      telegramChatId: payload.telegramChatId,
      telegramUsername: payload.telegramUsername,
    });
    await this.repo.bindNonceToUser({
      nonceHash,
      userId: user.id,
      telegramUserId: payload.telegramUserId,
      telegramChatId: payload.telegramChatId,
      telegramUsername: payload.telegramUsername,
    });

    let initialCredentials: { username: string; password: string } | null = null;
    if (createdNewUser && !user.passwordHash) {
      try {
        initialCredentials = await this.provisionInitialCredentials({
          userId: user.id,
          telegramUsername: payload.telegramUsername,
          telegramUserId: payload.telegramUserId,
        });
      } catch (err) {
        this.log.warn(
          { err, userId: user.id },
          "[telegram-signup] bare-start auto-provision creds failed",
        );
      }
    }

    return {
      finishUrl: this.buildFinishUrl(raw),
      createdNewUser,
      initialCredentials,
    };
  }

  /**
   * Task #47: password-reset через Telegram. User жмёт «Восстановить через TG»
   * на /login → website генерит `r_<nonce>` → бот видит сигнатуру → этот
   * метод вызывается. Поведение:
   *   - new user (не было ранее с этим TG-id) → register как обычный signup
   *   - existing user → **новый password** генерится, hash перезаписывается,
   *     plaintext возвращается для DM. Username остаётся прежним.
   */
  async handleBotReset(payload: BotStartHandlePayload): Promise<{
    finishUrl: string;
    createdNewUser: boolean;
    credentials: { username: string; password: string } | null;
  }> {
    const nonceHash = sha256Hex(payload.rawNonce);
    const row = await this.repo.findNonce(nonceHash);
    if (!row) throw new SignupNonceError("not_found");
    if (row.consumedAt) throw new SignupNonceError("already_consumed");
    if (row.expiresAt.getTime() < Date.now()) throw new SignupNonceError("expired");

    const existing = await this.repo.findUserByTelegramId(payload.telegramUserId);
    let user: UserRow;
    let createdNewUser: boolean;
    if (existing) {
      user = existing;
      createdNewUser = false;
    } else {
      user = await this.repo.createTelegramUser({
        telegramUserId: payload.telegramUserId,
        telegramUsername: payload.telegramUsername,
        firstName: payload.firstName,
        lastName: payload.lastName,
        telegramChatId: payload.telegramChatId,
      });
      createdNewUser = true;
      await this.audit.log({
        actorUserId: user.id,
        action: "auth.telegram_reset_created",
        payload: { telegramUserId: payload.telegramUserId },
      });
    }
    await this.repo.ensureUserDefaults({
      userId: user.id,
      telegramChatId: payload.telegramChatId,
      telegramUsername: payload.telegramUsername,
    });
    await this.repo.bindNonceToUser({
      nonceHash,
      userId: user.id,
      telegramUserId: payload.telegramUserId,
      telegramChatId: payload.telegramChatId,
      telegramUsername: payload.telegramUsername,
    });

    // Генерим новый password для reset OR initial для new user.
    const newPassword = randomBytes(12).toString("base64url");
    const newPasswordHash = await hashPassword(newPassword);
    let username = user.username ?? null;
    if (!username) {
      // New user или existing без username — provision через тот же helper
      // (он handlит UNIQUE conflict).
      try {
        const provisioned = await this.provisionInitialCredentials({
          userId: user.id,
          telegramUsername: payload.telegramUsername,
          telegramUserId: payload.telegramUserId,
        });
        // ВАЖНО: provisionInitialCredentials уже set'нул password. Возвращаем
        // его (а не наш newPassword выше — теряем consistency но не критично).
        return {
          finishUrl: this.buildFinishUrl(payload.rawNonce),
          createdNewUser,
          credentials: provisioned,
        };
      } catch (err) {
        this.log.warn(
          { err, userId: user.id },
          "[telegram-signup] reset provision creds failed",
        );
        return {
          finishUrl: this.buildFinishUrl(payload.rawNonce),
          createdNewUser,
          credentials: null,
        };
      }
    }
    // Existing user with username: просто перезаписываем password (без
    // username change).
    await this.repo.updatePasswordHash(user.id, newPasswordHash);
    await this.audit.log({
      actorUserId: user.id,
      action: "auth.telegram_password_reset",
      payload: { telegramUserId: payload.telegramUserId },
    });
    return {
      finishUrl: this.buildFinishUrl(payload.rawNonce),
      createdNewUser,
      credentials: { username, password: newPassword },
    };
  }

  /**
   * Шаг 3: user открыл finishUrl в браузере.
   *
   * Атомарно consume nonce. Возвращает либо ok + user (для caller'а,
   * который выпустит cookies), либо `gone` если nonce невалиден.
   *
   * Caller (route handler) сам решает 410 vs redirect по outcome.
   */
  async finishLogin(rawNonce: string): Promise<FinishLoginOutcome> {
    const nonceHash = sha256Hex(rawNonce);
    const row = await this.repo.consumeNonce(nonceHash);
    if (!row || !row.userId) {
      return { kind: "gone" };
    }
    const user = await this.findUserById(row.userId);
    if (!user) {
      this.log.warn(
        { nonceHash, userId: row.userId },
        "[telegram-signup] consumed nonce → user not found (deleted?)",
      );
      return { kind: "gone" };
    }
    return {
      kind: "ok",
      user,
      needsPasswordSetup: !user.passwordHash,
    };
  }

  /**
   * Шаг 4: /auth/set-password (authenticated по cookie из /finish).
   *
   * Caller гарантирует, что `user.passwordHash` сейчас NULL (иначе
   * это попытка перезаписи существующего пароля — не наш сценарий).
   * Caller также проверяет `username` на формат (zod schema).
   *
   * UNIQUE-conflict на username (другой юзер уже занял такой ник) →
   * repo бросит — caller вернёт 409.
   */
  async setInitialPassword(
    userId: string,
    passwordHash: string,
    username: string | null,
  ): Promise<void> {
    await this.repo.setInitialPasswordAndUsername(
      userId,
      passwordHash,
      username,
    );
    await this.audit.log({
      actorUserId: userId,
      action: "auth.set_initial_password",
      payload: { hasUsername: !!username },
    });
  }

  private buildFinishUrl(rawNonce: string): string {
    // Бот ведёт ПРЯМО в API-роут — это GET, который выпускает cookies
    // и сам делает 302 на /auth/set-password или /. Caddy в проде
    // проксирует `/api/*` в api контейнер; на dev Vite-proxy тоже.
    // Если шли бы на frontend `/login/finish`, пришлось бы держать
    // там redirect-страницу или Caddy-rewrite — лишний прыжок без выгоды.
    return `${this.cfg.siteOrigin}/api/v1/auth/telegram/finish?nonce=${encodeURIComponent(rawNonce)}`;
  }

  private async findUserById(userId: string): Promise<UserRow | null> {
    // Без status-фильтра — signup-user имеет status="pending" до
    // прохождения set-password.
    return this.repo.findUserAnyStatusById(userId);
  }
}

export class SignupNonceError extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "already_consumed"
      | "expired"
      | "conflict",
  ) {
    super(`Telegram signup nonce error: ${reason}`);
    this.name = "SignupNonceError";
  }
}

/**
 * Распознать сигнатуру signup-start-code из /start <code>.
 * Возвращает raw nonce (без `s_` prefix) или null если это
 * link-existing-account flow (telegram_links table).
 */
export function parseSignupStartCode(rawCode: string): string | null {
  const m = rawCode.match(/^s_(.+)$/);
  return m && m[1] ? m[1] : null;
}

/**
 * Task #47: распознать reset-flow code (`r_<nonce>`). Используется
 * password-reset через Telegram: пользователь жмёт «Восстановить через
 * Telegram» на /login → website генерит nonce → бот видит payload.
 */
export function parseResetStartCode(rawCode: string): string | null {
  const m = rawCode.match(/^r_(.+)$/);
  return m && m[1] ? m[1] : null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface SignupBotMessages {
  /** Сообщение бота когда signup ok (включает finish-ссылку). */
  ok(
    finishUrl: string,
    createdNewUser: boolean,
    initialCredentials?: { username: string; password: string } | null,
  ): string;
  /** Сообщение когда nonce expired / not found / уже consumed. */
  error(reason: SignupNonceError["reason"]): string;
  /**
   * Task #47: сообщение для password-reset flow.
   * createdNewUser=true → registered + sent creds (тот же welcome).
   * createdNewUser=false → existing user, sent NEW password.
   */
  passwordReset(
    finishUrl: string,
    createdNewUser: boolean,
    credentials: { username: string; password: string } | null,
  ): string;
}

export const defaultSignupBotMessages: SignupBotMessages = {
  ok(finishUrl, createdNewUser, initialCredentials) {
    const greeting = createdNewUser
      ? "🎉 Добро пожаловать в *Capflow*!"
      : "👋 С возвращением!";
    // Task #43: для нового пользователя бот шлёт ГОТОВЫЕ login + password +
    // ссылку + инструкцию. Returning users получают только finish-link.
    if (createdNewUser && initialCredentials) {
      const siteOrigin =
        finishUrl.match(/^(https?:\/\/[^/]+)/)?.[1] ?? "https://cap-flow.ru";
      return (
        `${greeting}\n\n` +
        `Ваш Capflow-аккаунт создан. Сохраните данные входа:\n\n` +
        `🔑 *Логин:* \`${initialCredentials.username}\`\n` +
        `🔒 *Пароль:* \`${initialCredentials.password}\`\n\n` +
        `🌐 *Сайт:* ${siteOrigin}\n\n` +
        `*Как войти:*\n` +
        `1. Откройте ${siteOrigin}\n` +
        `2. Нажмите «Войти» и введите логин/пароль выше\n` +
        `3. Или используйте одноразовую ссылку ниже (действует 10 минут):\n${finishUrl}\n\n` +
        `📚 *Что дальше:* добавьте свои кошельки в /wallets, ` +
        `и Capflow начнёт трекать ваши DeFi-позиции, PnL, fees и доходность ` +
        `автоматически.\n\n` +
        `⚠️ Пароль показывается ТОЛЬКО один раз — сохраните его в менеджере паролей. ` +
        `Сменить пароль можно в *Настройки → Мой профиль* после входа.`
      );
    }
    return (
      `${greeting}\n\n` +
      `Чтобы войти на сайт, нажмите кнопку ниже (или откройте ссылку):\n${finishUrl}\n\n` +
      `Ссылка одноразовая и действует 10 минут.`
    );
  },
  passwordReset(finishUrl, createdNewUser, credentials) {
    if (createdNewUser && credentials) {
      // Reset для нового user'а = просто signup. Используем тот же welcome.
      return defaultSignupBotMessages.ok(finishUrl, true, credentials);
    }
    const siteOrigin =
      finishUrl.match(/^(https?:\/\/[^/]+)/)?.[1] ?? "https://cap-flow.ru";
    if (credentials) {
      return (
        `🔐 *Сброс пароля Capflow*\n\n` +
        `Мы сгенерировали новый пароль для вашего аккаунта:\n\n` +
        `🔑 *Логин:* \`${credentials.username}\`\n` +
        `🔒 *Новый пароль:* \`${credentials.password}\`\n\n` +
        `🌐 *Сайт:* ${siteOrigin}\n\n` +
        `Войдите на сайт с новым паролем (кнопка ниже / ссылка / вручную). ` +
        `Старый пароль больше не работает.\n\n` +
        `⚠️ Сохраните новый пароль в менеджере паролей. ` +
        `Сменить его можно в *Настройки → Мой профиль* после входа.`
      );
    }
    // Edge case: reset не смог сгенерить creds.
    return (
      `✅ Подтверждён вход через Telegram.\n\n` +
      `Перейдите по ссылке для входа: ${finishUrl}\n\n` +
      `Если у вас был пароль — он остался прежним. ` +
      `Если нет — нажмите «Сменить пароль» в *Настройки → Мой профиль* после входа.`
    );
  },
  error(reason) {
    switch (reason) {
      case "expired":
        return "❌ Срок действия ссылки истёк. Откройте cap-flow.ru заново и нажмите «Войти через Telegram».";
      case "already_consumed":
        return "❌ Эта ссылка уже была использована. Откройте cap-flow.ru и сгенерируйте новую.";
      case "conflict":
        return "❌ Ссылка предназначалась другому Telegram-аккаунту. Откройте cap-flow.ru и нажмите «Войти через Telegram» заново.";
      case "not_found":
      default:
        return "❌ Неверная ссылка активации. Откройте cap-flow.ru и нажмите «Войти через Telegram» заново.";
    }
  },
};

