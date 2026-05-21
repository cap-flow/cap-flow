import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

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
import { ApiError } from "@/lib/api/client";

/**
 * Одноразовая страница после Telegram-signup login.
 *
 * Frontend проверяет: если у текущего user'а уже задан пароль — мы
 * сюда не должны были попасть; редирект на /. Backend всё равно
 * вернёт 409 при попытке, но это запасной слой.
 *
 * UI:
 *   - greeting по first_name / telegram_username (что есть в /me)
 *   - login (username) — preset = telegram_username, editable
 *   - password + confirm (8+ симв)
 *   - inline-инструкция про закладку
 *
 * После успешного сохранения — мы НЕ перерефрешим session
 * (passwordHash меняется в БД, токены остаются те же). Сразу
 * redirect /.
 */
export function SetPasswordPage(): JSX.Element {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<
    "username" | "password" | null
  >(null);

  // Pre-fill username из имени Telegram (поле name в /me для
  // signup-юзеров содержит telegram username). Если ничего нет —
  // оставляем пустым (валидация требует 3+ симв, юзер заполнит).
  useEffect(() => {
    if (!user) return;
    // Pre-fill приоритет: telegramUsername > name (= telegram_username
    // fallback из toMe). Без regex-санации — серверная валидация всё
    // равно нормализует.
    const preset = user.telegramUsername ?? user.name ?? "";
    if (!username && preset) {
      const candidate = preset.replace(/[^a-zA-Z0-9_]/g, "");
      if (candidate.length >= 3) setUsername(candidate);
    }
    // Если passwordHash уже есть (зашли сюда по ошибке) — редирект.
    if (user.needsPasswordSetup === false) {
      navigate("/", { replace: true });
    }
  }, [user, username, navigate]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setFieldError(null);

    if (password.length < 8) {
      setFieldError("password");
      setError("Пароль должен быть минимум 8 символов.");
      return;
    }
    if (password !== confirm) {
      setFieldError("password");
      setError("Пароли не совпадают.");
      return;
    }
    if (username && !/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      setFieldError("username");
      setError("Логин: 3-32 символа, только латиница, цифры и _.");
      return;
    }

    setSubmitting(true);
    try {
      await authApi.setInitialPassword({
        password,
        ...(username ? { username } : {}),
      });
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          const body = err.body as { error?: string; field?: string };
          if (body?.field === "username") {
            setFieldError("username");
            setError(body.error ?? "Этот логин уже занят.");
          } else if (body?.field === "password") {
            // password уже задан → silently redirect (мы и так не должны быть тут).
            navigate("/", { replace: true });
            return;
          } else {
            setError(body?.error ?? "Конфликт данных.");
          }
        } else if (err.status === 429) {
          setError("Слишком много попыток. Подождите несколько минут.");
        } else {
          setError(`Не удалось сохранить (HTTP ${err.status}).`);
        }
      } else {
        setError("Не удалось связаться с сервером. Проверьте подключение.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const greetingName =
    user?.name?.trim() || user?.telegramUsername?.trim() || "новый пользователь";

  return (
    <div className="flex min-h-screen items-center justify-center px-4 app-glow">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Добро пожаловать, {greetingName}!</CardTitle>
          <CardDescription>
            Завершите настройку аккаунта — это занимает 30 секунд.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="username">Логин</Label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={submitting}
                placeholder="Например, ваш Telegram-ник"
                aria-invalid={fieldError === "username"}
              />
              <p className="text-xs text-muted-foreground">
                Под этим логином вы сможете заходить в систему. По умолчанию мы
                подставили ваш Telegram-ник — можно изменить.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Пароль</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                aria-invalid={fieldError === "password"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Повторите пароль</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
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

            <div className="rounded-md border border-brand-cyan/30 bg-brand-cyan/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              <span className="mr-1" aria-hidden="true">
                📌
              </span>
              <strong className="font-medium text-foreground">
                Сохраните страницу в закладки
              </strong>{" "}
              (Ctrl+D / ⌘+D) — это ваш персональный вход в Capflow. Логин и
              пароль пригодятся, если вы захотите зайти без Telegram.
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || !password || !confirm}
            >
              {submitting ? "Сохраняем…" : "Создать аккаунт"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
