// User / auth / billing — used in Phase 0-1.
export * from "./users.js";
export * from "./accounts.js";
export * from "./sessions.js";
export * from "./audit_log.js";
export * from "./feature_flags.js";
export * from "./auth_tokens.js";
export * from "./edit_requests.js";
export * from "./user_payments.js";
export * from "./invites.js";
export * from "./api_usage.js";

// Reference data (Phase 2) — global, shared across all accounts.
export * from "./chain_registry.js";
export * from "./coingecko_registry.js";
export * from "./historical_prices.js";

// Per-account overrides on top of global reference data (Phase 2).
export * from "./cg_id_overrides.js";

// Worker-written analytics outputs (Phase 4).
export * from "./portfolio_snapshots.js";

// Notification delivery linkage + per-user subscriptions (Phase 7).
export * from "./telegram_links.js";
export * from "./notification_subscriptions.js";

// Telegram-based primary auth (signup/login through bot, 2026-05-21).
export * from "./telegram_signup_nonces.js";

// Crypto subscription billing (Phase 8).
export * from "./crypto_payment_addresses.js";
export * from "./payment_transactions.js";

// Wallets + addresses (post-Phase 8, inherited DB schema).
export * from "./wallets.js";

// Operations ledger (Phase 4a, inherited DB schema). Source for cost basis.
export * from "./operations.js";

// UCB B5: server-side cache of DeBank/Helius classified on-chain ops.
// Frozen JSON shape, cross-device access, foundation for BullMQ worker.
export * from "./chain_operations.js";

// UCB A3: per-op user-driven annotations (overrides classifier decisions).
// One-to-many w/ chain_operations; survives re-classification.
export * from "./chain_operation_annotations.js";

// Admin-editable upstream API key overrides (Phase S6 / 2026-05-14).
export * from "./integration_secrets.js";

// CEX exchange API connections per user (2026-05-14).
export * from "./cex_accounts.js";

// UCB C1: client-supplied cost basis seeds for CEX deposits.
export * from "./cex_deposit_seeds.js";
