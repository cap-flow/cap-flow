import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { purgeLegacyAuthStorage } from "./lib/auth/csrf";
import { LoadedWalletsProvider } from "./components/data/LoadedWalletsProvider";

// One-shot migration: scrub any legacy access/refresh tokens we ever
// might have stored in localStorage. Current build never writes them
// (in-memory `tokenStore` + httpOnly refresh cookie), but a returning
// user from a pre-cookie build could have stale entries lingering.
purgeLegacyAuthStorage();
import { SidebarProvider } from "./components/layout/SidebarProvider";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { AuthProvider } from "./features/auth/AuthProvider";
import { I18nProvider } from "./i18n/I18nProvider";
import "./index.css";
// Side-effect import: registers `window.capflowSelfCheck` для verification
// LotTracker/PositionTracker (Этап 12 / Фазы 3-7).
import "./lib/portfolio/lots/self_check";
// Регистрируем DefiLlama oracle для авто-детекта unknown protocols
// (решает whitelist scaling problem). Каталог загружается лениво при
// первом использовании, кэшируется 24h в localStorage.
import {
  loadLlamaProtocols,
  getProtocolMetadataSync,
  mapDefiLlamaToProtocolCategory,
} from "./lib/defillama_protocols";
import { registerReceiptLessOracle } from "./lib/portfolio/token_roles";
import { registerProtocolCatalogOracle } from "./lib/portfolio/protocols";

// Триггерим background load каталога — занимает ~1-2 сек, кэшируется.
loadLlamaProtocols().catch(() => {
  /* offline / blocked — fallback на hardcoded whitelist */
});

// Регистрируем oracle: для unknown protocols отдаёт DefiLlama-based
// детект receipt-less. Возвращает null если каталог ещё не загружен —
// тогда `isReceiptLessProtocol` падает на hardcoded whitelist.
registerReceiptLessOracle((protocolId, protocolName) => {
  const meta = getProtocolMetadataSync(protocolId, protocolName);
  if (!meta || meta.source !== "defillama") return null;
  return meta.isReceiptLess;
});

// Регистрируем catalog oracle для classifyProtocol (A0: protocols.ts moved to
// @cap-flow/ucb, DefiLlama-каталог теперь инъецируется тем же паттерном).
// Возвращает null если каталог ещё не загружен → fallback на "other", как
// и раньше при cold-start пустом snapshot'е.
registerProtocolCatalogOracle((projectId, projectName) => {
  const meta = getProtocolMetadataSync(projectId, projectName);
  if (meta?.llama?.category) {
    return {
      name: meta.llama.name ?? null,
      category: mapDefiLlamaToProtocolCategory(meta.llama.category),
    };
  }
  return null;
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element '#root' not found in index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider defaultTheme="dark">
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              {/* LoadedWalletsProvider depends on useAuth() to drop
                  cached wallet data when the auth subject changes
                  (admin <-> impersonation, user switch). Must sit
                  inside AuthProvider AND inside QueryClient (for
                  hydration's useQuery). */}
              <LoadedWalletsProvider>
                <SidebarProvider>
                  <App />
                </SidebarProvider>
              </LoadedWalletsProvider>
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>
);
