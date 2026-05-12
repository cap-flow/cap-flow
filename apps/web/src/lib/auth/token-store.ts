/**
 * In-memory access-token store with subscribe API.
 *
 * The refresh token lives in an httpOnly cookie (managed by the backend),
 * so we never persist the access token to localStorage — losing it on
 * reload is fine, because `/auth/refresh` will mint a new one as long as
 * the refresh cookie is valid.
 *
 * Subscribers are notified on change so React components can re-render
 * (login → token appears, logout / 401-no-refresh → token disappears).
 */
type Listener = (token: string | null) => void;

class TokenStore {
  private accessToken: string | null = null;
  private listeners = new Set<Listener>();

  get(): string | null {
    return this.accessToken;
  }

  set(token: string | null): void {
    if (this.accessToken === token) return;
    this.accessToken = token;
    for (const l of this.listeners) l(token);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}

export const tokenStore = new TokenStore();
