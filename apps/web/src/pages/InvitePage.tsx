import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

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
import { ApiError, api as _api } from "@/lib/api/client";
import { tokenStore } from "@/lib/auth/token-store";

/**
 * Public landing for `/invite/:token` — three states:
 *   1. loading the preview
 *   2. preview loaded → render registration form (email is read-only,
 *      it's whatever the admin put on the invite)
 *   3. submitted → API returns LoginResponse, we mirror what AuthProvider
 *      does on login() (store token + refresh) and navigate to /
 */
export function InvitePage(): JSX.Element {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);

  const [name, setName] = useState("");
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

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await publicInvitesApi.register(token, {
        password,
        name: name.trim(),
      });
      // Mirror AuthProvider.login: stash the access token, then let
      // /auth/me re-populate the context.
      tokenStore.set(res.accessToken);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403)
          setFormError("Приглашение уже использовано или отозвано.");
        else if (err.status === 409)
          setFormError("Пользователь с таким email уже зарегистрирован.");
        else if (err.status === 400)
          setFormError("Проверьте поля формы (пароль ≥ 12 символов).");
        else setFormError(`Ошибка ${err.status}.`);
      } else {
        setFormError("Сеть недоступна.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 app-glow">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Приглашение в Capflow</CardTitle>
          {previewLoading ? (
            <CardDescription>Загружаем приглашение…</CardDescription>
          ) : preview ? (
            <CardDescription>
              Создайте пароль для <b>{preview.email}</b>.<br />
              Ссылка действует до{" "}
              {new Date(preview.expiresAt).toLocaleString("ru")}.
            </CardDescription>
          ) : (
            <CardDescription className="text-destructive">
              {previewError ?? "Приглашение недоступно."}
            </CardDescription>
          )}
        </CardHeader>
        {preview && (
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="name">Имя</Label>
                <Input
                  id="name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                  placeholder="Как к вам обращаться"
                />
              </div>
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
                  submitting || !name.trim() || password.length < 12
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

// _api kept for type-only import to silence unused; avoids accidental
// regression where someone removes the auth client import wholesale.
void _api;
