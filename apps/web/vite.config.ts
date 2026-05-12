import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      // DeBank Cloud Pro API — без CORS, поэтому ходим через прокси.
      "/debank": {
        target: "https://pro-openapi.debank.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/debank/, ""),
      },
      // Helius — Solana enhanced API. Прокидываем, чтобы api-key не светился
      // в логах сторонних скриптов и было консистентно с DeBank.
      "/helius": {
        // api.helius.xyz отдаёт и transactions, и balances, и DAS — единый домен.
        target: "https://api.helius.xyz",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/helius/, ""),
      },
      // DefiLlama historical prices — публичный, без ключа.
      "/defillama": {
        target: "https://coins.llama.fi",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/defillama/, ""),
      },
      // DefiLlama Protocols API — публичный каталог DeFi-протоколов с
      // categories/chains/slugs. Используется для авто-классификации
      // неизвестных протоколов вместо hardcoded whitelist'а.
      "/llamaprotos": {
        target: "https://api.llama.fi",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/llamaprotos/, ""),
      },
      // Etherscan v2 unified API (chainId param) — для V3 NFT
      // IncreaseLiquidity logs. Free tier 5 req/s, без block-range limits
      // (vs Alchemy free tier 10-block range). Требует api key.
      "/etherscan": {
        target: "https://api.etherscan.io",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/etherscan/, ""),
      },
      // Jupiter Portfolio API — DeFi-позиции по 50+ Solana протоколам
      // (Flash Trade, Drift, Kamino, Marginfi, …). Требует x-api-key.
      // Должен идти ПЕРЕД /jupiter, чтобы prefix-match не схватил его.
      "/jup-portfolio": {
        target: "https://api.jup.ag",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/jup-portfolio/, "/portfolio"),
      },
      // Jupiter Price API — публичный, для USD-цен SPL-токенов.
      "/jupiter": {
        target: "https://api.jup.ag",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/jupiter/, ""),
      },
      // Vybe Network — unified DeFi positions для Solana (Flash Trade, Drift, Kamino, …).
      "/vybe": {
        target: "https://api.vybenetwork.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/vybe/, ""),
      },
      // CoinStats — универсальный wallet API (147 сетей: TON, Bitcoin, Aptos,
      // Sui, Cosmos, Cardano, новые EVM L2 типа Berachain/Monad/HyperEVM).
      "/coinstats": {
        target: "https://openapiv1.coinstats.app",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/coinstats/, ""),
      },
      // CoinGecko — исторические цены для V3 mint'ов на момент tx (timestamp).
      // Совпадает с методологией Revert Finance: они мульти-биржевую
      // aggregation цену в minute/hour bucket'е. Free tier ~30 calls/min.
      "/coingecko": {
        target: "https://api.coingecko.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/coingecko/, "/api/v3"),
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
});
