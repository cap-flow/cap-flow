import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { LogoLockup } from "@/components/brand/Logo";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { emailVerificationApi } from "@/features/email-verification/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useT } from "@/i18n/I18nProvider";
import { ApiError } from "@/lib/api/client";

/**
 * `/verify-email/:token` — public landing for the email-verification link.
 *
 * Calls `POST /api/v1/auth/email-verification/confirm/:token` once on mount.
 * The token is single-use; React StrictMode in dev intentionally double-
 * mounts and the second call returns 403 (consumed) — we treat that as
 * success because the **first** call did the work.
 *
 * Outcomes:
 *   - confirmed: green check + "Готово" + link to dashboard / login
 *   - already-verified: green check, "ваш email уже подтверждён ранее"
 *   - expired/used/unknown: red X + actionable hint (request a new link
 *     once logged in)
 */
export function VerifyEmailPage(): JSX.Element {
  const { token = "" } = useParams<{ token: string }>();
  const { user } = useAuth();
  const t = useT();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; email: string; wasAlready: boolean }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    let consumed = false;
    (async () => {
      try {
        const r = await emailVerificationApi.confirm(token);
        if (cancelled) return;
        consumed = true;
        setState({
          kind: "ok",
          email: r.email,
          wasAlready: r.wasAlreadyVerified,
        });
      } catch (err) {
        if (cancelled) return;
        // React StrictMode double-mount race: 2nd call may hit 403 because
        // the 1st already consumed. Don't surface that as an error.
        if (err instanceof ApiError && err.status === 403 && consumed) return;
        if (err instanceof ApiError) {
          if (err.status === 404)
            setState({
              kind: "error",
              message: t("verifyEmail.error.notFound"),
            });
          else if (err.status === 403)
            setState({
              kind: "error",
              message: t("verifyEmail.error.expired"),
            });
          else
            setState({
              kind: "error",
              message: t("login.error.generic", String(err.status)),
            });
        } else {
          setState({ kind: "error", message: t("login.error.network") });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12 app-glow">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-center pb-2">
            <LogoLockup />
          </div>
          <CardTitle className="text-xl">{t("verifyEmail.title")}</CardTitle>
          {state.kind === "loading" && (
            <CardDescription>{t("verifyEmail.checking")}</CardDescription>
          )}
          {state.kind === "ok" && (
            <CardDescription>
              {state.wasAlready
                ? t("verifyEmail.alreadyVerified")
                : t("verifyEmail.success")}
            </CardDescription>
          )}
          {state.kind === "error" && (
            <CardDescription className="text-destructive">
              {state.message}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-center py-4">
            {state.kind === "loading" && (
              <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
            )}
            {state.kind === "ok" && (
              <CheckCircle2 className="h-12 w-12 text-success" />
            )}
            {state.kind === "error" && (
              <XCircle className="h-12 w-12 text-destructive" />
            )}
          </div>
          {state.kind === "ok" && (
            <div className="space-y-2 text-center text-sm text-muted-foreground">
              <p>
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
                  {state.email}
                </code>
              </p>
              <Button asChild className="w-full">
                <Link to={user ? "/" : "/login"}>
                  {user ? t("verifyEmail.goHome") : t("login.submit")}
                </Link>
              </Button>
            </div>
          )}
          {state.kind === "error" && (
            <div className="space-y-2 text-center text-sm">
              <Button asChild variant="outline" className="w-full">
                <Link to="/login">{t("verifyEmail.goLogin")}</Link>
              </Button>
              <p className="text-xs text-muted-foreground">
                Если вы уже залогинены — откройте Настройки и нажмите
                «Отправить заново».
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
