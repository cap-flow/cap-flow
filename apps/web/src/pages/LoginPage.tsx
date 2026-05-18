import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, type Location } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/AuthProvider";
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

  return (
    <div className="flex min-h-screen items-center justify-center px-4 app-glow">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{t("login.title")}</CardTitle>
          <CardDescription>{t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
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
              className="w-full"
              disabled={submitting || !email || !password}
            >
              {submitting ? t("login.submitting") : t("login.submit")}
            </Button>
            {/* B3: previously the password-reset request page existed but
                had no entry point from /login, locking out anyone who
                forgot their password. Direct link here is the standard
                recovery affordance every SaaS auth screen has. */}
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
