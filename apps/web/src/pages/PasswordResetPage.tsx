import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

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
import { passwordResetApi } from "@/features/password-reset/api";
import { ApiError } from "@/lib/api/client";

/**
 * Two routes share this file:
 *   /reset-password         — request form (enter email; always 204 back)
 *   /reset-password/:token  — confirm form (new password)
 */

export function PasswordResetRequestPage(): JSX.Element {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await passwordResetApi.request(email.trim().toLowerCase());
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Слишком много попыток. Попробуйте через 15 минут.");
      } else {
        setError("Сеть недоступна.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Wrapper title="Сброс пароля">
      {done ? (
        <p className="text-sm text-muted-foreground">
          Если такой адрес зарегистрирован, мы отправили инструкции на{" "}
          <b>{email}</b>. Проверьте почту.
          <br />
          <Link to="/login" className="text-primary hover:underline">
            Вернуться к входу
          </Link>
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <p className="text-sm text-muted-foreground">
            Введите email — мы отправим ссылку для сброса. (Ответ одинаков
            для зарегистрированных и незарегистрированных адресов.)
          </p>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
            className="w-full"
            disabled={submitting || !email}
          >
            {submitting ? "Отправляем…" : "Отправить инструкции"}
          </Button>
          <p className="text-center text-sm">
            <Link to="/login" className="text-muted-foreground hover:underline">
              Вернуться к входу
            </Link>
          </p>
        </form>
      )}
    </Wrapper>
  );
}

export function PasswordResetConfirmPage(): JSX.Element {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await passwordResetApi.confirm(token, password);
      navigate("/login", {
        replace: true,
        state: { resetSuccess: true },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401)
          setError("Ссылка истекла или уже использована.");
        else if (err.status === 400)
          setError("Пароль должен быть не короче 12 символов.");
        else setError(`Ошибка ${err.status}.`);
      } else {
        setError("Сеть недоступна.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Wrapper title="Новый пароль">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-muted-foreground">
          Введите новый пароль. Все ваши активные сессии будут завершены.
        </p>
        <div className="space-y-2">
          <Label htmlFor="password">Новый пароль (≥ 12 символов)</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
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
          className="w-full"
          disabled={submitting || password.length < 12}
        >
          {submitting ? "Сохраняем…" : "Установить пароль"}
        </Button>
      </form>
    </Wrapper>
  );
}

function Wrapper({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 app-glow">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>Capflow</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
