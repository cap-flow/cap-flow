# Frontend

## Стек

- React 18 + TypeScript
- Vite (dev server + build)
- React Router 6 (`/registry`, `/performance`, `/portfolio`, `/settings`)
- Tailwind CSS + shadcn-style components в `components/ui/`
- viem для EVM RPC (Этап 3)

## Страницы

| Path | File | Назначение |
|---|---|---|
| `/` | `pages/HomePage.tsx` | Лендинг |
| `/registry` | `pages/RegistryPage.tsx` | Реестр сырых on-chain операций |
| `/performance` | `pages/OpenPositionsPage.tsx` | Лист открытых позиций + аналитика |
| `/portfolio` | `pages/PortfolioPage.tsx` | Live state кошелька + спот-балансы |
| `/settings` | `pages/SettingsPage.tsx` | API-ключи, профиль, язык, тема |
| `/users` | `pages/UsersPage.tsx` | (заготовка из шаблона) |

## Ключевые провайдеры

`apps/web/src/main.tsx` оборачивает приложение в:
- `I18nProvider` — ru/en через `useT()`/`useI18n()`
- `ThemeProvider` — light/dark
- `SidebarProvider` — состояние боковой панели
- `LoadedWalletsProvider` — единый источник правды по on-chain данным
- `QueryClientProvider` (TanStack Query) — для users API

## LoadedWalletsProvider

`components/data/LoadedWalletsProvider.tsx` — самый важный контекст. Хранит:

```ts
loadedById: Record<walletId, {
  wallet,
  ops: ClassifiedOp[],     // классифицированные операции
  snapshot: PortfolioSnapshot,  // снапшот балансов из ops
  live?: LiveSnapshot,     // текущий on-chain state
  loadedAt
}>
```

Действия: `load()`, `loadAll()`, `forget()`. Гидратируется из localStorage
(`capflow.cache.v6.wallet.{id}`).

## Главные «таблицы» в UI

### RegistryPage
- 8-колоночная таблица raw ops
- Фильтр-поиск, чекбокс «скрыть спам»
- Колонка «Тип» — для `lp_remove` показывает [[lp-cost-basis|cost basis]] бейдж

### OpenPositionsPage
- Шапка: 6+3 карточек аналитики
- 17 колонок per-position (см. [[../ROADMAP|ROADMAP]])
- Чекбокс кредитной метки + бейдж `credit`
- V3InfoButton на иконке ℹ️ — попап с диапазонами через [[v3-pipeline|RPC]]

## Компоненты

- `components/ui/` — кнопки, карточки, инпуты (shadcn-style)
- `components/layout/AppShell.tsx` — сайдбар + контент
- `components/data/LoadedWalletsProvider.tsx` — провайдер описан выше
- `components/portfolio/LiveStateView.tsx` — компонент для PortfolioPage
- `components/profile/Avatar.tsx`, `AvatarPicker.tsx` — в шапке
- `components/i18n/LanguageSelector.tsx`
- `components/theme/ThemeToggle.tsx`

## Локали

`i18n/locales/ru.ts` и `en.ts` — flat объекты ключей. Используется через
`useT()(`registry.title`)`.
