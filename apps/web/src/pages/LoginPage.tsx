import { useEffect, useState, type FormEvent } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  type Location,
} from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/AuthProvider";
import { authApi } from "@/features/auth/api";
import { useT } from "@/i18n/I18nProvider";
import { ApiError } from "@/lib/api/client";

interface LoginLocationState {
  readonly from?: string;
}

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const location = useLocation() as Location & {
    state: LoginLocationState | null;
  };

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Telegram-signup state. Когда юзер нажал «Войти через Telegram»,
  // мы открываем deep-link в новой вкладке (или текущей, если запрещён
  // popup) и показываем waiting-UI с инструкцией.
  const [tgPending, setTgPending] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  // Если редиректнули с /finish?error=expired_link — покажем баннер.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const errParam = params.get("error");
    if (errParam === "expired_link") {
      setTgError(
        "Срок действия ссылки активации истёк или она уже использована. Нажмите «Войти через Telegram» ещё раз.",
      );
    }
  }, [location.search]);

  const from = location.state?.from ?? "/";

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login({ email: email.trim().toLowerCase(), password });
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError(t("login.error.rateLimit"));
        } else if (err.status === 401) {
          setError(t("login.error.invalid"));
        } else {
          setError(t("login.error.generic", String(err.status)));
        }
      } else {
        setError(t("login.error.network"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTelegramSignup(): Promise<void> {
    setTgError(null);
    setTgPending(true);
    try {
      const r = await authApi.startTelegramSignup();
      // Открываем deep-link в новой вкладке. Если popup-blocker
      // не пустит — fallback: window.location.assign на текущей.
      const opened = window.open(r.botDeepLink, "_blank", "noopener");
      if (!opened) {
        window.location.assign(r.botDeepLink);
      }
      // tgPending остаётся true — показывает waiting-UI: «нажмите
      // /start в боте, после чего вернётесь по ссылке из чата».
    } catch (err) {
      setTgPending(false);
      if (err instanceof ApiError && err.status === 429) {
        setTgError("Слишком частые попытки. Подождите минуту и попробуйте снова.");
      } else if (err instanceof ApiError) {
        setTgError(`Не удалось начать вход через Telegram (HTTP ${err.status}).`);
      } else {
        setTgError("Не удалось связаться с сервером. Проверьте подключение и попробуйте снова.");
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 app-glow">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{t("login.title")}</CardTitle>
          <CardDescription>{t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* ─── Telegram primary CTA ────────────────────────────── */}
          {tgPending ? (
            <div
              role="status"
              className="space-y-3 rounded-lg border border-brand-cyan/40 bg-brand-cyan/5 px-4 py-4 text-sm"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden="true">🤖</span>
                <div className="space-y-1.5 leading-relaxed">
                  <div className="font-medium text-foreground">
                    Откройте Telegram и нажмите{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
                      /start
                    </code>{" "}
                    у бота
                  </div>
                  <div className="text-muted-foreground">
                    Бот пришлёт вам в чат уникальную ссылку для входа на
                    сайт. Откройте её — и вы окажетесь в аккаунте.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTgPending(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Отменить
              </button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => void handleTelegramSignup()}
              className="w-full bg-[#0088cc] text-white hover:bg-[#0077b3]"
            >
              <span className="mr-2" aria-hidden="true">
                ✈
              </span>
              Войти через Telegram
            </Button>
          )}
          {tgError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {tgError}
            </p>
          )}

          <div className="relative my-3">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-card px-2 text-xs uppercase tracking-wider text-muted-foreground">
                или
              </span>
            </div>
          </div>

          {/* ─── Existing email/password form ───────────────────── */}
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">{t("login.email")}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t("login.password")}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
            </div>
            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="outline"
              className="w-full"
              disabled={submitting || !email || !password}
            >
              {submitting ? t("login.submitting") : t("login.submit")}
            </Button>
            <div className="text-center">
              <Link
                to="/reset-password"
                className="text-sm text-brand-cyan hover:underline focus:underline focus:outline-none"
              >
                {t("login.forgotPassword")}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
