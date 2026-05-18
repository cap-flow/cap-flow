/**
 * CSRF double-submit helper.
 *
 * On a successful auth flow (login / refresh / register-by-invite) the
 * backend sets two cookies:
 *   - `cap_access`  — HttpOnly access JWT.
 *   - `cap_csrf`    — non-HttpOnly random token.
 *
 * The frontend reads the second cookie via `document.cookie` and echoes
 * it back in the `X-CSRF-Token` header on every state-changing request
 * (POST/PUT/PATCH/DELETE). On the server we verify cookie value equals
 * header value in constant time (see `apps/api/src/plugins/csrf.ts`).
 *
 * Why double-submit:
 *   - No stateful CSRF token store needed.
 *   - SameSite=Lax + httpOnly access cookie prevent the side-channel
 *     paths an attacker would use to read or replay the token.
 */

export const CSRF_COOKIE_NAME = "cap_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

/**
 * Reads the CSRF token from `document.cookie`. Returns `null` if the
 * cookie is absent (logged-out, expired, or cookie blocked) — the caller
 * should treat that as "skip CSRF header" and let the server return 403
 * which the auth refresh path handles.
 */
export function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const all = document.cookie;
  if (!all) return null;
  const prefix = `${CSRF_COOKIE_NAME}=`;
  for (const raw of all.split(";")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * One-time migration: clear legacy `cap.accessToken` / `cap.refreshToken`
 * keys from localStorage if any deployment ever wrote them there. This
 * is purely defensive — the current code never writes auth tokens to
 * localStorage, but a previous build (or a developer-mode export) might
 * have left them behind.
 */
export function purgeLegacyAuthStorage(): void {
  if (typeof localStorage === "undefined") return;
  const keys = [
    "cap.accessToken",
    "cap.refreshToken",
    "capflow.accessToken",
    "capflow.refreshToken",
    "auth.accessToken",
    "auth.refreshToken",
  ];
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      // localStorage blocked (private mode, Safari ITP).
    }
  }
}
