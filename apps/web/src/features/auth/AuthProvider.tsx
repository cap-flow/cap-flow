import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { onUnauthorized } from "@/lib/api/client";
import { tokenStore } from "@/lib/auth/token-store";

import { authApi, type LoginInput, type Me } from "./api";

/**
 * Lightweight snapshot of the admin's own session before impersonation
 * starts. We can't restore the *refresh cookie* (httpOnly, server set it
 * for the target user when /impersonate ran), so "Завершить" doesn't
 * silently return the admin — it logs out everything and pushes to
 * /login. The snapshot is purely for displaying "back to" info in the
 * banner.
 */
interface ImpersonationOrigin {
  readonly admin: Me;
}

interface AuthState {
  /** undefined = booting (initial /auth/refresh + /auth/me in-flight). */
  readonly user: Me | null | undefined;
  readonly isAdmin: boolean;
  readonly isImpersonating: boolean;
  readonly impersonationOrigin: ImpersonationOrigin | null;
  readonly login: (input: LoginInput) => Promise<Me>;
  readonly logout: () => Promise<void>;
  /** Manually re-fetch /auth/me — useful after impersonation. */
  readonly refresh: () => Promise<void>;
  /**
   * Replace the current session with an impersonation session for the
   * given user. The backend mints a new access token and overrides our
   * httpOnly refresh cookie — so when this returns, we *are* the target
   * user (role="user") until we explicitly logout.
   */
  readonly startImpersonation: (args: {
    accessToken: string;
    impersonatedUserId: string;
  }) => Promise<Me>;
  readonly endImpersonation: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  // undefined = still booting (we haven't probed the refresh cookie yet).
  // null     = booted and confirmed: no session.
  // Me       = booted and authenticated.
  const [user, setUser] = useState<Me | null | undefined>(undefined);
  const [origin, setOrigin] = useState<ImpersonationOrigin | null>(null);
  const bootedRef = useRef(false);

  // Boot: try once on mount. If we don't have an access token (we never do
  // on a hard reload), the api client will see 401 from /auth/me, call
  // /auth/refresh, get a new token, retry /auth/me, and resolve.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      try {
        const me = await authApi.me();
        setUser(me);
      } catch {
        setUser(null);
      }
    })();
  }, []);

  // The api client invokes this when refresh failed → no recoverable session.
  useEffect(() => {
    onUnauthorized(() => {
      setUser(null);
      setOrigin(null);
    });
    return () => onUnauthorized(null);
  }, []);

  const login = useCallback(async (input: LoginInput): Promise<Me> => {
    const res = await authApi.login(input);
    tokenStore.set(res.accessToken);
    setUser(res.user);
    setOrigin(null);
    return res.user;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } catch {
      // Even if the network call fails, drop local state.
    }
    tokenStore.set(null);
    setUser(null);
    setOrigin(null);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const me = await authApi.me();
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  const startImpersonation = useCallback(
    async (args: {
      accessToken: string;
      impersonatedUserId: string;
    }): Promise<Me> => {
      // Save the admin snapshot *before* swapping the token. Once we set
      // the new token, /auth/me will return the target user — there's no
      // way to recover the admin's identity afterwards.
      setOrigin(user && user.role === "admin" ? { admin: user } : null);
      tokenStore.set(args.accessToken);
      const me = await authApi.me();
      setUser(me);
      return me;
    },
    [user]
  );

  const endImpersonation = useCallback(async (): Promise<void> => {
    // POST /auth/end-impersonation:
    //   - revokes the impersonation session server-side
    //   - mints a fresh admin session and sets the admin refresh cookie
    //   - returns the admin's access token + me-shaped payload
    //
    // The endpoint lives under /auth (not /admin/users/.../impersonate)
    // so the impersonated user (role=user, no admin gate) can call it.
    //
    // If anything fails — admin row gone, role demoted, network — we
    // fall back to a hard logout so the impersonation banner doesn't
    // strand the user.
    try {
      const res = await authApi.endImpersonation();
      tokenStore.set(res.accessToken);
      setUser(res.user);
      setOrigin(null);
    } catch (err) {
      console.error("[auth] end-impersonation failed, hard logout", err);
      await logout();
    }
  }, [logout]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isAdmin: user?.role === "admin" && !user?.impersonation,
      isImpersonating: !!user?.impersonation,
      impersonationOrigin: origin,
      login,
      logout,
      refresh,
      startImpersonation,
      endImpersonation,
    }),
    [user, origin, login, logout, refresh, startImpersonation, endImpersonation]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
