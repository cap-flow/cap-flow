-- UCB server-port enablers (Epic A1): golden_cases + anomaly_flags.
--
-- Additive only (two new tables, no alters) — reversible by backup, no
-- down-script. Applied on prod DB BEFORE any code reads these tables.
--
--   golden_cases : per-position EXPECTED-OUTPUT oracle (frozen, versioned),
--                  the regression anchor. User-scoped via wallet_id.
--   anomaly_flags: detector findings (mutable lifecycle). User-scoped via
--                  account_id (+ nullable wallet_id).
--
-- These are deliberately separate from chain_operation_annotations (per-op
-- mutable INPUT a user forces) — golden/anomaly are proven/observed OUTPUT.

CREATE TABLE golden_cases (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id                UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,

  position_id              TEXT NOT NULL,
  chain                    TEXT NOT NULL,
  protocol_id              TEXT NOT NULL,
  market_key               TEXT,
  open_hash                TEXT,
  label                    TEXT NOT NULL,

  expected_start_usd       NUMERIC(20, 6),
  expected_net_start_usd   NUMERIC(20, 6),
  expected_pnl_usd         NUMERIC(20, 6),
  tolerance_abs_usd        NUMERIC(20, 6) NOT NULL DEFAULT 1,
  tolerance_pct            NUMERIC(8, 6)  NOT NULL DEFAULT 0.02,

  source_of_truth          TEXT NOT NULL,
  provenance_note          TEXT,
  methodology_version      TEXT NOT NULL,

  fixture_path             TEXT,
  status                   TEXT NOT NULL DEFAULT 'active',
  created_by_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Soft link (no FK) to the anomaly this was promoted from — avoids a
  -- circular dependency with anomaly_flags.
  promoted_from_anomaly_id UUID,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One golden per (wallet, position).
CREATE UNIQUE INDEX golden_cases_wallet_position_uq
  ON golden_cases (wallet_id, position_id);
CREATE INDEX golden_cases_wallet_idx ON golden_cases (wallet_id);
CREATE INDEX golden_cases_chain_market_idx ON golden_cases (chain, market_key);
CREATE INDEX golden_cases_label_idx ON golden_cases (label);


CREATE TABLE anomaly_flags (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet_id        UUID REFERENCES wallets(id) ON DELETE CASCADE,

  position_id      TEXT,
  chain            TEXT,
  protocol_id      TEXT,
  market_key       TEXT,

  check_id         TEXT NOT NULL,
  anomaly_type     TEXT,
  severity         TEXT NOT NULL,
  phase            TEXT NOT NULL DEFAULT 'pre',
  observed_value   NUMERIC(20, 6),
  expected_value   NUMERIC(20, 6),
  detail           JSONB,
  golden_case_id   UUID REFERENCES golden_cases(id) ON DELETE SET NULL,

  status           TEXT NOT NULL DEFAULT 'open',
  detector_version TEXT,
  resolved_note    TEXT,

  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ
);

-- Idempotency key: one finding per (account, wallet, position, check). We
-- include position_id (the plan's draft omitted it, which would collapse
-- distinct positions tripping the same check). NULLS NOT DISTINCT (PG15+) so
-- account-level findings (null wallet/position) still dedupe.
CREATE UNIQUE INDEX anomaly_flags_idem_uq
  ON anomaly_flags (account_id, wallet_id, position_id, check_id)
  NULLS NOT DISTINCT;
CREATE INDEX anomaly_flags_status_idx ON anomaly_flags (status);
CREATE INDEX anomaly_flags_wallet_idx ON anomaly_flags (wallet_id);
