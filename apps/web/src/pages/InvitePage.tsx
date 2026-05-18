import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { LogoLockup } from "@/components/brand/Logo";
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
import { publicInvitesApi, type InvitePreview } from "@/features/invites/api";
import { ApiError } from "@/lib/api/client";
import { tokenStore } from "@/lib/auth/token-store";

/**
 * Public landing for `/invite/:token`.
 *
 * Two invite kinds:
 *   - **email-bound** (legacy): preview.email != null → form shows the
 *     email read-only and only asks for password (+ optional name).
 *   - **open link** (Phase S7): preview.email == null → form asks for
 *     email AND password. User fully self-identifies; admin only sees
 *     the result after consumption.
 */
export function InvitePage(): JSX.Element {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await publicInvitesApi.preview(token);
        if (!cancelled) setPreview(p);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          if (err.status === 404)
            setPreviewError("Приглашение не найдено или уже использовано.");
          else if (err.status === 403)
            setPreviewError("Приглашение истекло или отозвано.");
          else setPreviewError(`Ошибка ${err.status}.`);
        } else {
          setPreviewError("Сеть недоступна.");
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const isOpenInvite = preview && preview.email == null;

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const body = isOpenInvite
        ? { email: email.trim().toLowerCase(), password }
        : { password };
      const res = await publicInvitesApi.register(token, body);
      tokenStore.set(res.accessToken);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403)
          setFormError("Приглашение уже использовано или отозвано.");
        else if (err.status === 409)
          setFormError(
            "Пользователь с таким email уже зарегистрирован. Воспользуйтесь восстановлением пароля."
          );
        else if (err.status === 400)
          setFormError(
            "Проверьте поля формы: email корректный, пароль ≥ 12 символов."
          );
        else setFormError(`Ошибка ${err.status}.`);
      } else {
        setFormError("Сеть недоступна.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12 app-glow">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-center pb-2">
            <LogoLockup />
          </div>
          <CardTitle className="text-xl">Регистрация в Capflow</CardTitle>
          {previewLoading ? (
            <CardDescription>Проверяем приглашение…</CardDescription>
          ) : preview ? (
            <CardDescription>
              {isOpenInvite ? (
                <>
                  Заполните email и пароль — аккаунт создастся автоматически.
                  <br />
                  Ссылка действует до{" "}
                  {new Date(preview.expiresAt).toLocaleString("ru-RU")}.
                </>
              ) : (
                <>
                  Создайте пароль для <b>{preview.email}</b>.
                  <br />
                  Ссылка действует до{" "}
                  {new Date(preview.expiresAt).toLocaleString("ru-RU")}.
                </>
              )}
            </CardDescription>
          ) : (
            <CardDescription className="text-destructive">
              {previewError ?? "Приглашение недоступно."}
            </CardDescription>
          )}
        </CardHeader>
        {preview && (
          <CardContent className="space-y-4">
            {preview.notes && (
              <div className="rounded-md border border-brand-cyan/30 bg-brand-cyan/5 px-3 py-2.5 text-sm">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-brand-cyan">
                  Сообщение от администратора
                </div>
                <div className="whitespace-pre-wrap text-foreground">
                  {preview.notes}
                </div>
              </div>
            )}

            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              {isOpenInvite ? (
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={submitting}
                    placeholder="you@example.com"
                  />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="email-readonly">Email</Label>
                  <Input
                    id="email-readonly"
                    type="email"
                    value={preview.email ?? ""}
                    readOnly
                    disabled
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="password">Пароль (≥ 12 символов)</Label>
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
              {formError && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {formError}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={
                  submitting ||
                  password.length < 12 ||
                  (isOpenInvite && !email.trim())
                }
              >
                {submitting ? "Создаём аккаунт…" : "Создать аккаунт"}
              </Button>
            </form>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
