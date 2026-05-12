---
date: 2026-05-11
stage: SaaS Phase 7
---

# SaaS Phase 7 — notifications: email (Resend) + Telegram skeleton

## Контекст

Phase 0-6 крутились вокруг внутренних данных. Phase 7 — первый
исходящий канал к пользователю:

- **Email** для password reset, invite-ссылок, в перспективе для
  systeem-alerts (refresh failed, аккаунт без обновлений).
- **Telegram skeleton** — owner просил «архитектуру подготовить» под
  будущий бот, но сам бот пока не хочет хостить. Phase 7 ставит
  таблицу `telegram_links`, выдаёт one-time `/start` коды и no-op-ит
  outgoing send-ы; Phase 7b включит реальный bot listener одной правкой.
- **Subscription model** — per-user, per-channel, per-type opt-in/opt-out
  для будущих типов алертов.

## Решение

### Один façade — три канала

`NotificationsService.send({user, type, subject, bodyText, transactional?})`:
1. Проверяет `subscriptions.isEnabled(user, type, 'email'|'telegram')` —
   *кроме* `transactional: true` (password reset / invite, которые
   обязательны).
2. Параллельно пытается **email** (`EmailClient.send`) и **telegram**
   (`TelegramService.send`).
3. Каждый успех/провал → audit row `notification.email_sent|email_failed|
   telegram_sent|telegram_skipped`.

Convenience-методы: `sendPasswordReset(user, url)`, `sendInvite(email, url, inviterName)`.

### Email — Resend + stdout-fallback

`EmailClient.isLive` определяется наличием `RESEND_API_KEY`. Когда ключа
нет (dev, ранний beta) — `send()` печатает в stdout:

```
[email-stub] to=alice@example.com subject="Сброс пароля Capflow"
Здравствуйте! …
```

Один shape ответа в обоих режимах (`{messageId, mode: "resend"|"stdout"}`)
— call-sites не ветвятся. Audit-row сохраняет `mode`, так что админ
видит «улетело реально или печаталось».

### Telegram — два state machine

Таблица `telegram_links` (pending / linked / revoked):

```
   user clicks "Connect Telegram"  ──►  pending  ──┐ (15min TTL)
                                                    │
   bot receives /start <code>      ──►  linked  ◄──┘
                                       │
   user clicks "Disconnect"        ──►  revoked
```

**Phase 7 поставляет только верх**: POST `/me/telegram/start` выдаёт
one-time code (sha-256 в БД) + deep-link `t.me/<bot>?start=<code>`
(deep-link пуст пока `TELEGRAM_BOT_USERNAME` не задан). Метод
`TelegramService.completeLink({rawCode, chatId, telegramUsername})`
уже готов и его вызовет bot-listener в Phase 7b — без правок call-sites.

`TelegramService.send(userId, text)`:
- нет linked-row → `return false` (audit пометит `telegram_skipped`)
- нет `botApiToken` → `return false`
- иначе HTTP POST в `api.telegram.org/bot<token>/sendMessage`

### Subscriptions

Таблица `notification_subscriptions(user_id, type, channel, enabled)`
с composite PK. **Default = true**: новая фича, на которую юзер не
делал opt-out, считается активной (важные алерты приходят по умолчанию).
Отписаться = `PUT { enabled: false }`. Тип — открытый text без enum,
чтобы новые алерты появлялись без миграции.

## Альтернативы

- **SendGrid / Postmark вместо Resend** — Resend free tier 3000 писем/мес
  + лучший DX (один POST + JSON). Postmark надёжнее под высокую транзакц.
  нагрузку; перейдём если будет реальная боль. Сам интерфейс — наш
  `EmailClient` — provider-agnostic.
- **Webhook-only Telegram bot** vs. long-polling — отложили вместе с
  Phase 7b. Архитектура service-а одинакова для обоих режимов.
- **Хранить raw `/start <code>` в БД** для повторной выдачи юзеру —
  отвергли: не хотим plaintext тайны в state. Если юзер потеряет код —
  re-issue (старый pending revoked в `startLink`).
- **Подключить tech-audit → email-alert админу** прямо тут — отложили
  на Phase 7b/Phase 8 (cron worker для tech-audit).

## Реализация

**Schema** (`packages/db/src/schema/`):
- `telegram_links.ts` — pending/linked/revoked state с TTL.
- `notification_subscriptions.ts` — user × type × channel × enabled
  composite PK.

**Migration** `drizzle/0003_phase7_notifications.sql` — идемпотентная
(CREATE TABLE IF NOT EXISTS + DO $$ enum). Применена.

**Модули**:
- `notifications/email-client.ts` — Resend HTTP + stdout-fallback.
- `notifications/notification-subscriptions.repository.ts` — list/upsert/isEnabled.
- `notifications/notifications.service.ts` — façade.
- `notifications/notifications.routes.ts` — `GET/PUT /me/notifications`.
- `telegram/telegram.repository.ts` — CRUD по `telegram_links`.
- `telegram/telegram.service.ts` — startLink, status, unlink, send,
  completeLink (для bot listener в Phase 7b).
- `telegram/telegram.routes.ts` — `GET/POST/DELETE /me/telegram`.

**Интеграция**:
- `auth/password-reset.service.ts` — заменил прямой stdout-write на
  `notifications.sendPasswordReset(user, resetUrl)`. Теперь audit
  записывает `notification.email_sent` mode=resend|stdout.
- `invites/invites.service.ts` — после `createInvite` вызывает
  `notifications.sendInvite(email, inviteUrl, null)`. Catch — admin-ответ
  всё равно содержит URL, так что email — convenience, не hard-fail.

**Env** добавлено:
- `RESEND_API_KEY` (optional)
- `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`
- `TELEGRAM_BOT_USERNAME` (optional)
- `TELEGRAM_LINK_TTL_MIN` (15)

## E2E (13/13 пройдено)

| # | Сценарий | Результат |
|---|---|---|
| 1 | admin POST /admin/invites + email-stub в stdout | `[email-stub] to=charlie@example.com subject="Приглашение в Capflow"` |
| 2 | password reset request → 204 + email-stub | `[email-stub] subject="Сброс пароля Capflow"` |
| 3 | GET /me/telegram (свежий юзер) | `state:"none"` |
| 4 | POST /me/telegram/start | `{code, deepLink:"", expiresAt}` (deepLink пуст без BOT_USERNAME) |
| 5 | GET /me/telegram | `state:"pending"` |
| 6-9 | PUT × 2 + GET subscriptions | 2 ряда, корректные значения |
| 10 | DELETE /me/telegram | `{revoked: 1}` |
| 11 | GET → state:"none" | ✓ |
| 12 | Anonymous → /me/telegram | 401 ✓ |
| 13 | audit_log: `notification.email_sent mode=stdout`, `notification.telegram_skipped`, `telegram.link_started`, `telegram.unlinked` | ✓ |

## Ограничения

- **Telegram bot не запущен** — outgoing send-ы no-op-ят (audit пишет
  `telegram_skipped`). Phase 7b: настроить `TELEGRAM_BOT_USERNAME` +
  `TELEGRAM_BOT_API_TOKEN` env, добавить webhook-handler endpoint
  `POST /webhooks/telegram` который вызовет
  `telegramService.completeLink(...)` на `/start <code>`. Без правок
  service-а или call-sites.
- **Resend не подключен** — `RESEND_API_KEY=` в .env. Email-stub
  печатает в stdout (видно админу в `docker logs api`). Когда оплатим
  Resend — заполнить ключ → automatic switch без перезапуска call-sites.
- **Нет HTML-шаблонов для писем** — sendPasswordReset/sendInvite шлют
  только text. Resend поддерживает HTML — `EmailMessage.html?` уже в
  shape, добавлять не сложно когда дойдёт до UX brand-а.
- **Retry на email-fail не реализован** — single try, ошибка идёт в
  `notification.email_failed` audit. Для transactional flows можно
  добавить BullMQ-очередь повторов; пока flow «admin вручную пушит
  URL в чат если письмо не дошло».
- **Telegram raw `/start <code>` показывается юзеру один раз** —
  потеря = re-issue (revoke + create-new). Это правильно: код не
  переиздаётся deterministic'но.
- **Subscriptions default = true** для всех типов. Если когда-то
  появится «маркетинговый» тип (рассылка), его дефолт надо переключить
  на false вручную через миграцию или явный upsert.
- **Tech-audit hook → email-alert** не подключен — это в Phase 7b/Phase
  8 (cron `runAll` + email админу при `error`-severity findings).
- **HTML-шаблонизация локализована вручную** (рус строки в коде). Если
  будут не-русские юзеры — введём ICU/i18n message bundle.
