import { useLocalStorage } from "./useLocalStorage";

export interface Integrations {
  debankAccessKey: string;
  heliusApiKey: string;
  vybeApiKey: string;
  jupiterApiKey: string;
  alchemyApiKey: string;
  coinstatsApiKey: string;
  solscanApiKey: string;
  shyftApiKey: string;
  etherscanApiKey: string;
}

/**
 * **Phase S4 — SaaS-mode integrations**:
 *
 * Users do NOT configure API keys themselves. All upstream providers
 * (DeBank, Helius, Etherscan) are reached via the backend
 * upstream-proxy (`/api/v1/upstream/<provider>/*`), which injects the
 * admin's server-side key. The frontend just needs the relevant
 * `Integrations` field to be **non-empty** so downstream gating
 * (e.g. "skip Solana fetch if heliusApiKey is empty") still passes —
 * hence the `"managed-by-server"` sentinel for those three.
 *
 * **Alchemy** is the lone exception: viem's `http()` transport uses a
 * static `fetchOptions`, so we can't dynamically inject the user's
 * Bearer for backend-proxy auth. Until S3.5 lands a cookie-based
 * access session, `alchemyApiKey` keeps reading `VITE_ALCHEMY_API_KEY`
 * — a known temporary leak. Run a low-quota Alchemy key for closed
 * beta and rotate after S3.5.
 *
 * Other providers (Vybe / CoinStats / Jupiter / Solscan / Shyft) are
 * dormant under `SHOW_NON_EVM_PROVIDERS = false` — defaults left empty
 * to avoid baking unused env vars into the bundle.
 */
/** Non-empty sentinel: passes `if (key.trim())` gates downstream without
 *  the actual key leaking to the browser. */
const SERVER_MANAGED = "managed-by-server";

const DEFAULT: Integrations = {
  // ─── server-managed via backend upstream-proxy ──────────────────────
  // S1-S3: DeBank / Helius / Etherscan — via `apiFetch` (Bearer header)
  // S3.5: Alchemy — via viem `http()` + cookie (`cap_access`)
  debankAccessKey: SERVER_MANAGED,
  heliusApiKey: SERVER_MANAGED,
  etherscanApiKey: SERVER_MANAGED,
  alchemyApiKey: SERVER_MANAGED,

  // ─── dormant (feature-flagged off) ───────────────────────────────────
  // SHOW_NON_EVM_PROVIDERS = false in SettingsPage; these never fire.
  vybeApiKey: "",
  jupiterApiKey: "",
  coinstatsApiKey: "",
  solscanApiKey: "",
  shyftApiKey: "",
};

export function useIntegrations() {
  const [stored, setStored] = useLocalStorage<Integrations>(
    "capflow.integrations",
    DEFAULT,
  );
  // КРИТИЧНО: merge с DEFAULT чтобы новые поля не оставались undefined
  // у юзеров со старым localStorage cache. Дополнительно — S4 migration:
  // принудительно затираем server-managed поля даже если в localStorage
  // лежит реальный ключ из до-SaaS-эры. Frontend не должен использовать
  // эти ключи, и юзер не должен видеть их в Settings.
  const merged: Integrations = {
    ...DEFAULT,
    ...stored,
    debankAccessKey: SERVER_MANAGED,
    heliusApiKey: SERVER_MANAGED,
    etherscanApiKey: SERVER_MANAGED,
    alchemyApiKey: SERVER_MANAGED,
  };
  return [merged, setStored] as const;
}
