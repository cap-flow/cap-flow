import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { accountsApi, type Account } from "./api";
import { useAuth } from "@/features/auth/AuthProvider";

const ACTIVE_KEY = "capflow.activeAccountId";

export function useMyAccounts() {
  return useQuery({
    queryKey: ["accounts", "mine"],
    queryFn: () => accountsApi.listMine(),
    staleTime: 60_000,
  });
}

/**
 * Legacy convenience helper — returns the first account marked `isPrimary`.
 * Most callers should migrate to `useActiveAccount()` which honors the user's
 * own selection (when they have multiple accounts). Kept here for backwards
 * compat with code paths that haven't moved over yet.
 */
export function usePrimaryAccount(): Account | null | undefined {
  const q = useMyAccounts();
  if (q.isLoading) return undefined;
  return q.data?.find((a) => a.isPrimary) ?? null;
}

/**
 * The account the user is **currently working in**.
 *
 *   1. Reads `localStorage.capflow.activeAccountId`.
 *   2. Falls back to the first `isPrimary` account when nothing is selected
 *      (matches pre-switcher behavior).
 *   3. If the stored id no longer exists (archived / deleted), silently
 *      drops back to primary so the UI doesn't break.
 *
 * Resets on auth-subject change (admin impersonate / different user logs in
 * on the same browser): we clear the stored id so the new user doesn't see
 * the previous user's account selection.
 *
 * Returns `undefined` while accounts are loading and `null` if the user
 * has no accounts at all (edge case during onboarding).
 */
export function useActiveAccount(): Account | null | undefined {
  const q = useMyAccounts();
  const { user } = useAuth();
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(ACTIVE_KEY);
  });

  // Drop stored selection when the auth subject changes — previous user's
  // pick must not leak into the new session.
  const lastUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = user?.id ?? null;
    if (lastUserIdRef.current !== null && lastUserIdRef.current !== id) {
      try {
        localStorage.removeItem(ACTIVE_KEY);
      } catch {
        /* quota */
      }
      setActiveId(null);
    }
    lastUserIdRef.current = id;
  }, [user?.id]);

  if (q.isLoading) return undefined;
  const accounts = q.data ?? [];
  if (accounts.length === 0) return null;

  const stored = activeId
    ? accounts.find((a) => a.id === activeId && !a.archivedAt)
    : undefined;
  if (stored) return stored;

  const primary = accounts.find((a) => a.isPrimary && !a.archivedAt);
  return primary ?? accounts[0]!;
}

/**
 * Imperative setter for the active account. Persists to localStorage and
 * invalidates account-scoped queries (wallets, snapshots, refresh status)
 * so the UI re-fetches data for the new account immediately.
 */
export function useSwitchAccount(): (accountId: string) => void {
  const qc = useQueryClient();
  return useCallback(
    (accountId: string) => {
      try {
        localStorage.setItem(ACTIVE_KEY, accountId);
      } catch {
        /* quota — non-fatal, just won't survive a reload */
      }
      // Nudge consumers — emit a storage event so other tabs sync too.
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: ACTIVE_KEY,
          newValue: accountId,
        })
      );
      // Invalidate everything that scopes by account.
      qc.invalidateQueries({ queryKey: ["wallets"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
    [qc]
  );
}

