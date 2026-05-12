---
date: 2026-05-10
stage: SaaS Phase 1
---

# SaaS Phase 1 — invites, onboarding, восстановление пароля

## Контекст

Phase 0 закрыла фундамент (email/password, JWT, sessions, admin/user/viewer
роли). Phase 1 закрывает single missing piece: **как новые пользователи
попадают в систему**. По требованиям владельца — только по приглашению админа
с уникальной ссылкой, жёсткая привязка инвайта к email, одноразовость.
Параллельно — восстановление пароля для случая «забыл».

## Решение

**Invite-флоу — двухсторонний**:

1. Админ создаёт invite через `POST /api/v1/admin/invites { email, ttlHours?, notes? }`.
   Возвращается полный объект **плюс raw token и готовый inviteUrl — ровно
   один раз** (`token` нигде в БД не лежит в открытом виде, только SHA-256).
2. Получатель открывает `INVITE_BASE_URL/{token}` (фронт). Фронт делает
   `GET /api/v1/invites/{token}` чтобы показать email и срок.
3. Регистрация: `POST /api/v1/invites/{token}/register { password, name }` —
   email **не передаётся** из формы, берётся из invite (защита от подмены).
   В одном вызове: создаётся user, primary account "Main", invite
   помечается consumed, создаётся сессия → возвращается `accessToken` + cookie
   (**auto-login**).

**Жёсткая привязка к email**:
- Один pending invite на email (новый create → старый revoke).
- Email уже зарегистрирован → 409 на create (админу подсказка: «используйте
  password reset»).
- Передача ссылки другому человеку даёт ему регистрацию под чужим email —
  не имеет смысла, потому что email определяется инвайтом, не свободным
  полем.

**Восстановление пароля — через `auth_tokens`**:
- `POST /auth/password/reset-request { email }` → **всегда 204** (no
  enumeration). Если user активен — выпускается auth_tokens row с TTL 60 мин.
  Email-провайдер пока не подключен (Phase 7), URL печатается в stdout
  сервера, админ передаёт юзеру вручную.
- `POST /auth/password/reset-confirm { token, newPassword }` →
  обновляет password_hash, помечает токен consumed, **revoked все активные
  сессии юзера** (force re-login).

**Status flow для invites**:
```
   ┌── consumed (после регистрации)
   │
pending ──┬── revoked (админ отозвал)
           │
           └── expired (TTL прошёл; lazy-mark при listInvites / previewByToken)
```

## Альтернативы

- **Email как свободное поле при регистрации** — отвергли: даёт юзеру свободу
  зарегаться на любой email, ломает «приглашение конкретному человеку».
- **Передача refresh-token прямо в ответ на register** (без cookie) —
  отвергли: cookie-only хранит токен в браузере с httpOnly, не достижим из
  JS, защита от XSS.
- **Отдельный auto-login endpoint после register** — отвергли: лишний
  round-trip, регистрация и так не идемпотентна.
- **Magic-link для login** (юзер не запоминает пароль) — отложили, не
  требование. Сейчас invite + setup-пароля = базовый флоу.

## Реализация

**Модули** (все в `apps/api/src/modules/`):

- `invites/`
  - `invites.repository.ts` — create / findByTokenHash / findById / listAll /
    consume / revoke / markExpired / pendingByEmail.
  - `invites.service.ts` — createInvite (с auto-revoke pending дубликатов),
    previewByToken (404/403 с causes), registerByToken (создание user +
    account + consume invite + audit + auto-login).
  - `invites.routes.admin.ts` — POST/GET/DELETE под `requireAdmin`.
  - `invites.routes.public.ts` — GET preview, POST register под rate-limit.
  - `invites.schema.ts` — Zod схемы запросов/ответов; `inviteCreatedResponseSchema`
    добавляет `token` + `inviteUrl` только на момент создания.

- `accounts/`
  - `accounts.repository.ts` — findActiveByOwner, findPrimaryByOwner,
    createPrimary. Минимум для регистрации; полный CRUD в Phase 2.

- `auth/`
  - `password-reset.repository.ts` — create / findActiveByHash / consume /
    revokeAllSessionsForUser.
  - `password-reset.service.ts` — requestReset (всегда 204), confirmReset.
  - `password-reset.routes.ts` — два endpoint-а с rate-limit.
  - `auth.repository.ts` — расширен методами createUser, setPasswordHash,
    findUserByEmail.

**Env** (новое):
- `INVITE_BASE_URL` — куда фронт хостит invite landing (для построения URL
  при админском create).
- `PASSWORD_RESET_TTL_MIN` — TTL для reset-токенов (default 60 мин).
- `PASSWORD_RESET_BASE_URL` — куда фронт хостит reset-форму.

**Audit-события**:
- `invite.created` (target = email; payload.inviteId, expiresAt)
- `invite.consumed` (actorUserId = новый user)
- `invite.revoked` (actorUserId = админ)
- `user.registered` (payload.source = "invite", inviteId)
- `password.reset_requested` (target = email)
- `password.reset_confirmed` (payload.revokedSessions = count)

**Rate limits**:
- POST `/invites/:token/register` — 5 / 15 мин per-IP
- GET `/invites/:token` — 20 / 1 мин (anti-enumeration)
- POST `/auth/password/reset-request` — 5 / 15 мин
- POST `/auth/password/reset-confirm` — 10 / 15 мин

**E2E (17/17 пройдено)**:
1. Admin login → JWT.
2. Admin create invite for alice@example.com → 201 + raw token.
3. Public GET /invites/{token} → 200 с email.
4. Public GET /invites/{badtoken} → 404.
5. Public POST /register → 201, auto-login (access + cookie).
6. /me с новым токеном → 200, role=user.
7. Повторный register с тем же токеном → 403 «already used».
8. Admin create invite на уже зарегистрированный email → 409.
9. Admin revokes Bob's invite → status=revoked.
10. Register с revoked инвайтом → 403.
11. User (Alice) пытается hit /admin/invites → 403.
12. Admin list → видим Alice consumed + Bob revoked.
13. Password reset request → 204 (URL в stdout).
14. Password reset request для unknown email → 204 (no enumeration).
15. Confirm с валидным токеном → 204.
16. Login со старым паролем → 401; с новым → 200; old JWT → 401 (sessions revoked).
17. Reuse одного reset-токена → 401; expired token → 401.

После прогона в БД: 2 users (Vladimir+Alice), 2 invites (consumed+revoked),
9 событий в audit_log.

## Ограничения

- **`registerByToken` не в одной транзакции**. Между создания user / consume
  invite могут случиться сбой → invite остаётся pending, user уже создан.
  Принято как Phase 1 trade-off; Phase 2 (tx-aware repos) обернёт.
- **Email-провайдер не подключен** — reset URL и invite URL передаются
  владельцу через stdout / админ-ответ. Resend (или альтернатива) — Phase 7.
- **Один primary account на user, лимита нет в коде** — на beta админ не
  лимитирован; для user — лимит будет в сервисе accounts (Phase 2).
- **Тест на параллельную регистрацию** — два запроса с одним token могут
  одновременно создать двух users c одним email до уникального index match.
  В целом unique index `users_email_uq` поймает второго и вернёт 500. Можно
  улучшить через advisory lock на email (Phase 2).
- **Сейчас invite revoke не отзывает существующие сессии** (на момент revoke
  user мог уже зарегаться — но мы видим что revoke только pending инвайтов
  через `if (row.status !== "pending")` check).
- **TTL для invites — fixed-rate-limit + expires_at**. Cron-задача для
  массовой sweep expired инвайтов — пока lazy (при listInvites / previewByToken).
  Phase 4 (BullMQ) добавит периодический worker.
