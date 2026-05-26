import { useState } from "react";
import { Check, Loader2, Mail, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/AuthProvider";
import { emailVerificationApi } from "@/features/email-verification/api";
import { ApiError } from "@/lib/api/client";

const DISMISS_KEY = "capflow.emailVerifyBanner.dismissedUntil";

/**
 * Persistent banner shown while `user.emailVerifiedAt === null`.
 *
 * The banner is dismissible (per-browser, 24h cool-off) so it doesn't
 * become noise, but reappears every day until verified. After successful
 * verification (or on next refresh of /me) the banner self-hides because
 * `emailVerifiedAt` becomes non-null.
 *
 * "Отправить заново" calls POST /auth/email-verification/send. The
 * endpoint is auth-required and rate-limited at the API layer
 * (5/hour/user). Local "sent" state shows a green check for 1.5s as
 * feedback that the email is queued.
 */
/**
 * 2026-05-25 (user request): temporarily disable email verification banner.
 * Чтобы вернуть — изменить EMAIL_BANNER_ENABLED на true.
 */
const EMAIL_BANNER_ENABLED = false;

export function EmailVerificationBanner(): JSX.Element | null {
  const { user } = useAuth();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof localStorage === "undefined") return false;
    const until = Number(localStorage.getItem(DISMISS_KEY) ?? "0");
    return Number.isFinite(until) && until > Date.now();
  });

  // Hide when:
  //   - user not logged in (LoginPage / InvitePage / VerifyEmailPage)
  //   - verified
  //   - dismissed within the 24h window
  //   - impersonation: showing it as an admin acting-as-user is misleading
  if (!EMAIL_BANNER_ENABLED) return null;
  if (!user) return null;
  if (user.emailVerifiedAt) return null;
  if (user.impersonation) return null;
  if (dismissed) return null;

  async function handleResend() {
    setError(null);
    setSending(true);
    try {
      const r = await emailVerificationApi.send();
      if (r.alreadyVerified) {
        // Race condition: another tab confirmed first. Reload /me to update.
        setSent(true);
        setTimeout(() => window.location.reload(), 800);
        return;
      }
      setSent(true);
      setTimeout(() => setSent(false), 1500);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setError("Слишком часто. Попробуйте через час.");
      } else {
        setError("Не удалось отправить. Попробуйте позже.");
      }
    } finally {
      setSending(false);
    }
  }

  function handleDismiss() {
    try {
      const tomorrow = Date.now() + 24 * 3600 * 1000;
      localStorage.setItem(DISMISS_KEY, String(tomorrow));
    } catch {
      /* quota — non-fatal */
    }
    setDismissed(true);
  }

  return (
    <div className="sticky top-0 z-30 w-full border-b border-warning/40 bg-warning/10 px-4 py-2 text-warning backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center gap-3 text-sm">
        <Mail className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <strong className="font-semibold">Подтвердите ваш email.</strong>{" "}
          <span className="text-warning/90">
            Письмо со ссылкой ушло на <code>{user.email}</code>. Без подтверждения вы не сможете
            восстановить пароль или получать платёжные уведомления.
          </span>
          {error && (
            <div className="mt-1 text-xs text-destructive">{error}</div>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleResend}
          disabled={sending || sent}
          className="shrink-0 border-warning/50 hover:bg-warning/20"
        >
          {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {sent && <Check className="h-3.5 w-3.5 text-success" />}
          {!sending && !sent && "Отправить заново"}
          {sent && !sending && " Отправлено"}
        </Button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Скрыть на 24 часа"
          title="Скрыть на 24 часа"
          className="shrink-0 rounded p-1 text-warning/70 hover:bg-warning/20 hover:text-warning"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
