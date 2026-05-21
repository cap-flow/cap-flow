import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  Check,
  CreditCard,
  Database,
  Globe,
  History,
  Languages,
  Layers,
  Monitor,
  Moon,
  Palette,
  Save,
  SlidersHorizontal,
  Sun,
  Trash2,
  User,
  X,
  Zap,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label, Textarea } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api/client";
import { ThemeSelector } from "@/components/theme/ThemeToggle";
import { useTheme } from "@/components/theme/ThemeProvider";
import { LanguageSelector } from "@/components/i18n/LanguageSelector";
import { LOCALE_LABELS, useI18n, useT } from "@/i18n/I18nProvider";
import { AvatarPicker } from "@/components/profile/AvatarPicker";
import { useProfile, type UserProfile } from "@/components/profile/profile";
import { usePipelineSettings } from "@/lib/portfolio/pipeline_settings";
import { cn } from "@/lib/utils";
import { BillingPage } from "./BillingPage";
import { PreferencesPage } from "./PreferencesPage";

type Section =
  | "profile"
  | "appearance"
  | "language"
  | "advanced"
  | "subscription"
  | "notifications";

export function SettingsPage(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [section, setSection] = useState<Section>("profile");

  const handleClose = () => {
    // Возвращаемся туда где был пользователь до Settings, либо на дашборд.
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClose}
          aria-label="Закрыть настройки"
          title="Закрыть настройки"
        >
          <X />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
        <nav className="flex flex-row gap-1 overflow-x-auto md:flex-col">
          <SectionTab
            icon={<User className="h-4 w-4" />}
            label={t("settings.section.profile")}
            active={section === "profile"}
            onClick={() => setSection("profile")}
          />
          <SectionTab
            icon={<Palette className="h-4 w-4" />}
            label={t("settings.section.appearance")}
            active={section === "appearance"}
            onClick={() => setSection("appearance")}
          />
          <SectionTab
            icon={<Languages className="h-4 w-4" />}
            label={t("settings.section.language")}
            active={section === "language"}
            onClick={() => setSection("language")}
          />
          <SectionTab
            icon={<CreditCard className="h-4 w-4" />}
            label="Подписка"
            active={section === "subscription"}
            onClick={() => setSection("subscription")}
          />
          <SectionTab
            icon={<Bell className="h-4 w-4" />}
            label="Уведомления"
            active={section === "notifications"}
            onClick={() => setSection("notifications")}
          />
          {/* Дополнительно (pipeline, кэш, dev-инструменты) — только для
              admin'ов. Обычным юзерам этот раздел не нужен и сбивает с толку. */}
          {isAdmin && (
            <SectionTab
              icon={<SlidersHorizontal className="h-4 w-4" />}
              label="Дополнительно"
              active={section === "advanced"}
              onClick={() => setSection("advanced")}
            />
          )}
        </nav>

        <div className="space-y-6">
          {section === "profile" && <ProfileSection />}
          {section === "appearance" && <AppearanceSection />}
          {section === "language" && <LanguageSection />}
          {section === "subscription" && <BillingPage />}
          {section === "notifications" && <PreferencesPage />}
          {/* AdvancedSection доступен только админам (см. видимость
              кнопки выше). Защищаемся ещё и от прямой манипуляции
              state — если юзер изменит section вручную, fallback на
              profile. */}
          {section === "advanced" && isAdmin && <AdvancedSection />}
        </div>
      </div>
    </div>
  );
}

function SectionTab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <span className={active ? "text-brand-cyan" : "text-muted-foreground"}>
        {icon}
      </span>
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  My profile                                                                 */
/* -------------------------------------------------------------------------- */

function ProfileSection() {
  const t = useT();
  const [stored, setStored] = useProfile();
  const [draft, setDraft] = useState<UserProfile>(stored);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty =
    draft.username !== stored.username ||
    draft.displayName !== stored.displayName ||
    draft.email !== stored.email ||
    draft.bio !== stored.bio ||
    draft.avatar !== stored.avatar;

  const save = () => {
    setStored(draft);
    setSavedAt(Date.now());
    window.setTimeout(() => setSavedAt(null), 1500);
  };

  const reset = () => setDraft(stored);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.profile.avatar.title")}</CardTitle>
          <CardDescription>{t("settings.profile.avatar.sub")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AvatarPicker profile={draft} onChange={setDraft} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("settings.profile.info.title")}</CardTitle>
          <CardDescription>{t("settings.profile.info.sub")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="username">{t("settings.profile.field.login")}</Label>
              <Input
                id="username"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                placeholder={t("settings.profile.field.login.placeholder")}
                autoComplete="username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="displayName">
                {t("settings.profile.field.displayName")}
              </Label>
              <Input
                id="displayName"
                value={draft.displayName}
                onChange={(e) =>
                  setDraft({ ...draft, displayName: e.target.value })
                }
                placeholder={t("settings.profile.field.displayName.placeholder")}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="email">{t("settings.profile.field.email")}</Label>
              <Input
                id="email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder={t("settings.profile.field.email.placeholder")}
                autoComplete="email"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="bio">{t("settings.profile.field.bio")}</Label>
              <Textarea
                id="bio"
                value={draft.bio}
                onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                placeholder={t("settings.profile.field.bio.placeholder")}
                rows={3}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={reset} disabled={!dirty}>
              {t("common.reset")}
            </Button>
            <Button onClick={save} disabled={!dirty}>
              {savedAt ? <Check /> : <Save />}
              {savedAt ? t("common.saved") : t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Appearance                                                                 */
/* -------------------------------------------------------------------------- */

function AppearanceSection() {
  const t = useT();
  const { theme, resolved } = useTheme();
  const labels: Record<typeof theme, string> = {
    light: t("settings.theme.light"),
    dark: t("settings.theme.dark"),
    system: t("settings.theme.system"),
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.appearance.title")}</CardTitle>
        <CardDescription>{t("settings.appearance.sub")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-medium">{t("settings.appearance.theme")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.appearance.current")}:{" "}
              <span className="font-medium text-foreground">
                {theme === "system" ? `${labels.system} (${resolved})` : labels[theme]}
              </span>
            </p>
          </div>
          <ThemeSelector />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ThemePreview label={t("settings.theme.light")} icon={<Sun className="h-4 w-4" />} tone="light" />
          <ThemePreview label={t("settings.theme.dark")} icon={<Moon className="h-4 w-4" />} tone="dark" />
          <ThemePreview label={t("settings.theme.system")} icon={<Monitor className="h-4 w-4" />} tone="system" />
        </div>
      </CardContent>
    </Card>
  );
}

function ThemePreview({
  label,
  icon,
  tone,
}: {
  label: string;
  icon: React.ReactNode;
  tone: "light" | "dark" | "system";
}) {
  const styles: Record<typeof tone, { bg: string; fg: string; sub: string }> = {
    light: { bg: "#F5F8FB", fg: "#0F172A", sub: "#64748B" },
    dark: { bg: "#0B1220", fg: "#F8FAFC", sub: "#94A3B8" },
    system: {
      bg: "linear-gradient(135deg,#F5F8FB 0% 50%,#0B1220 50% 100%)",
      fg: "#0F172A",
      sub: "#64748B",
    },
  };
  const s = styles[tone];
  return (
    <div className="overflow-hidden rounded-md border border-border" style={{ background: s.bg }}>
      <div className="flex items-center justify-between p-3" style={{ color: s.fg }}>
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {label}
        </div>
        <span className="h-2 w-10 rounded-full bg-brand-gradient" />
      </div>
      <div className="space-y-2 px-3 pb-4" style={{ color: s.sub }}>
        <div className="h-2 w-3/4 rounded bg-current opacity-30" />
        <div className="h-2 w-1/2 rounded bg-current opacity-20" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Language                                                                   */
/* -------------------------------------------------------------------------- */

function LanguageSection() {
  const t = useT();
  const { locale } = useI18n();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-brand-cyan" />
          {t("settings.language.title")}
        </CardTitle>
        <CardDescription>{t("settings.language.sub")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-medium">{t("settings.language.title")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settings.language.current")}:{" "}
              <span className="font-medium text-foreground">{LOCALE_LABELS[locale]}</span>
            </p>
          </div>
          <LanguageSelector />
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Advanced — pipeline + кэш. Заменили старый раздел "Интеграции"             */
/*  (Phase S4: API-ключи теперь admin-managed; user-facing раздела нет).       */
/* -------------------------------------------------------------------------- */

function AdvancedSection() {
  return (
    <>
      <PipelineCard />
      <CacheCard />
      <DangerZoneCard />
    </>
  );
}

/**
 * M16 (2026-05-14): self-service account deletion (GDPR Art. 17 / 152-ФЗ).
 *
 * Hard-delete from the user's own settings — calls `DELETE /api/v1/auth/me`
 * which cascades through accounts → wallets/operations/snapshots/etc.
 * Last-admin protection is enforced server-side, so an admin who tries
 * this without promoting another admin first will get a clear error.
 *
 * Confirm-by-typing pattern (must type `email` for the button to enable)
 * to prevent accidental clicks. After success → logout + redirect to /login.
 */
function DangerZoneCard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const expectedConfirm = user.email || user.name || "delete";
  const canConfirm =
    confirmText.trim().toLowerCase() === expectedConfirm.toLowerCase();

  async function handleDelete() {
    setError(null);
    setSubmitting(true);
    try {
      await api.delete("/v1/auth/me");
      // Cookies are cleared server-side; force a logout-style reset
      // locally so any in-memory token disappears and React Query
      // caches drop.
      await logout();
      navigate("/login", { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive">
            <Trash2 className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base text-destructive">
              Удалить аккаунт
            </CardTitle>
            <CardDescription>
              Безвозвратное удаление аккаунта и всех связанных данных:
              кошельков, истории операций, snapshot'ов, платежей, подписок.
              Действие нельзя отменить. Полностью удаляет вас из системы
              (GDPR Art. 17 / 152-ФЗ).
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!open ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Удалить мой аккаунт
          </Button>
        ) : (
          <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4">
            <div className="text-sm">
              <strong>Точно удалить?</strong> Введите{" "}
              <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
                {expectedConfirm}
              </code>{" "}
              для подтверждения:
            </div>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={expectedConfirm}
              autoFocus
              autoComplete="off"
              disabled={submitting}
            />
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setConfirmText("");
                  setError(null);
                }}
                disabled={submitting}
              >
                Отмена
              </Button>
              <Button
                size="sm"
                onClick={handleDelete}
                disabled={!canConfirm || submitting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {submitting ? "Удаляем…" : "Удалить навсегда"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


/**
 * Live-first vs history-first pipeline.
 *
 * История CapFlow: изначально открытые позиции выводились через парсинг
 * всей истории операций (history-first), что давало «фантомные» позиции
 * после закрытия on-chain (если classifier не распознал withdraw).
 *
 * Live-first ставит API-снимок (DeBank/Helius/Vybe/CoinStats) единственной
 * точкой истины: что live API видит — то и показано. История нужна
 * только для cost basis / age / fees-claims существующих позиций.
 */
function PipelineCard() {
  const [settings, setSettings] = usePipelineSettings();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary text-brand-cyan">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base">Архитектура pipeline</CardTitle>
            <CardDescription>
              Как CapFlow определяет какие у вас открытые позиции.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <PipelineToggleRow
          icon={<Layers className="h-4 w-4" />}
          title="Live-first pipeline"
          description={
            <>
              Live API — единственная точка истины для открытых позиций.
              Inferred (восстановленные из истории) НЕ показываются на
              странице открытых позиций — они идут в Лист закрытых позиций.
              Это убирает «фантомов» от закрытых протоколов.{" "}
              <b>Рекомендуется всегда оставлять включённым.</b>
            </>
          }
          enabled={settings.useLiveFirst}
          onToggle={() =>
            setSettings({ ...settings, useLiveFirst: !settings.useLiveFirst })
          }
        />
        <PipelineToggleRow
          icon={<History className="h-4 w-4" />}
          title="Показывать в архиве «из истории»"
          description={
            <>
              Если в истории есть позиция, которая открывалась но закрытие
              classifier не распознал (например, withdraw помечен как swap
              для нестандартного протокола), и live API её не возвращает —
              показывать её в Листе закрытых позиций с пометкой ⚠ «Из
              истории». Не учитывается в аналитике в любом случае.
            </>
          }
          enabled={settings.inferredFallback}
          onToggle={() =>
            setSettings({
              ...settings,
              inferredFallback: !settings.inferredFallback,
            })
          }
        />
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
          После изменения — очистите кэш кошельков и обновите данные
          (карточка ниже), иначе изменения не применятся.
        </div>
      </CardContent>
    </Card>
  );
}

function PipelineToggleRow({
  icon,
  title,
  description,
  enabled,
  onToggle,
  disabled = false,
  disabledHint,
}: {
  icon: React.ReactNode;
  title: string;
  description: React.ReactNode;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 rounded-md border border-border bg-secondary/30 px-3 py-3",
        disabled && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-brand-cyan">
          {icon}
        </div>
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-[11px] leading-relaxed text-muted-foreground">
            {description}
          </div>
          {disabled && disabledHint && (
            <div className="text-[10px] text-muted-foreground/70">
              {disabledHint}
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          enabled ? "bg-brand-cyan" : "bg-secondary border border-border",
          disabled && "cursor-not-allowed",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
            enabled ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

/**
 * Сброс локального кэша кошельков.
 *
 * Зачем: расчёты (PnL / cost basis / lending) меняются между релизами.
 * Старые snapshot'ы в `localStorage.capflow.wallet_cache.*` пересчитаны по
 * прежней логике. После апдейта нужно их перестроить.
 *
 * Что удаляется: только wallet_cache.* (балансы и история по кошелькам).
 * Сохраняются: настройки, аннотации, ручные оверрайды, состав активов.
 */
function CacheCard() {
  const [busy, setBusy] = useState(false);

  function clearAndReload() {
    if (
      !window.confirm(
        "Удалить локальный кэш кошельков и перезагрузить страницу?\n\n" +
          "Сохраняются: API-ключи, профиль, аннотации операций, ручные " +
          "оверрайды (Стартовый капитал, currentValueUsd, fees, кредитные " +
          "метки), состав активов.\n\n" +
          "После перезагрузки нажмите «Обновить» в Cap Wallet — данные " +
          "подтянутся заново через DeBank/Helius.",
      )
    )
      return;
    setBusy(true);
    let removed = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("capflow.wallet_cache.")) {
        localStorage.removeItem(k);
        removed += 1;
      }
    }
    // Чтобы пользователь увидел сколько удалили — короткая пауза перед reload.
    setTimeout(() => {
      console.info(`Cleared ${removed} wallet cache entries`);
      window.location.reload();
    }, 150);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-secondary text-brand-cyan">
            <Database className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-base">Кэш данных</CardTitle>
            <CardDescription>
              Локальный кэш балансов и истории по каждому кошельку. Сбрасывайте
              при «странных» цифрах после апдейта формул.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2.5">
          <div className="text-xs text-muted-foreground">
            Удаляет только <code className="font-mono">capflow.wallet_cache.*</code>.
            Настройки, аннотации, оверрайды и API-ключи остаются.
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={clearAndReload}
            disabled={busy}
            className="shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Очистить кэш и перезагрузить
          </Button>
        </div>
        <CompositionResetRow />
      </CardContent>
    </Card>
  );
}

/**
 * Сброс составов активов (asset compositions).
 *
 * До live-first архитектуры пользователь мог задать состав через кнопку в
 * Cap Wallet — она сохраняла «глобально по символу», т.е. состав USDC
 * применялся ко всем позициям с USDC. Теперь кнопка в Cap Wallet удалена,
 * но старые global-записи могут остаться.
 *
 * Здесь даём кнопки сбросить:
 *   - Только глобальные (без scope) — сохраняет per-position составы.
 *   - Все составы — полный wipe.
 */
function CompositionResetRow() {
  const KEY = "capflow.asset_composition";

  function resetGlobal() {
    if (
      !window.confirm(
        "Удалить ВСЕ глобальные составы активов?\n\n" +
          "Глобальный состав — тот, что задавался без привязки к позиции " +
          "(например через старую кнопку в Cap Wallet). Per-position " +
          "составы (внутри карточки позиции) НЕ затрагиваются.",
      )
    )
      return;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, unknown>;
      let removed = 0;
      for (const k of Object.keys(obj)) {
        if (!k.includes("::")) {
          delete obj[k];
          removed += 1;
        }
      }
      localStorage.setItem(KEY, JSON.stringify(obj));
      window.alert(`Удалено ${removed} глобальных составов. Обновите страницу.`);
    } catch (e) {
      console.error("Reset global compositions failed:", e);
    }
  }

  function resetAll() {
    if (
      !window.confirm(
        "Удалить ВСЕ составы активов (и глобальные, и per-position)?\n\n" +
          "Это сбросит все wrapper-разложения (JLP=SOL+ETH, GLP=… и т.д.). " +
          "Придётся задавать заново.",
      )
    )
      return;
    localStorage.removeItem(KEY);
    window.alert("Все составы удалены. Обновите страницу.");
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">
        Сбросить составы активов (wrapper-разложения JLP / GLP / USDC →
        underlying). Если состав был задан «глобально по символу» и
        применился к позиции по ошибке — используйте «Сбросить глобальные».
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={resetGlobal}>
          Сбросить глобальные
        </Button>
        <Button variant="ghost" size="sm" onClick={resetAll} className="text-destructive">
          Сбросить все
        </Button>
      </div>
    </div>
  );
}

