--
-- PostgreSQL database dump
--


-- Dumped from database version 16.13
-- Dumped by pg_dump version 16.13

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: drizzle; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA drizzle;


--
-- Name: crypto_network; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.crypto_network AS ENUM (
    'trc20',
    'erc20'
);


--
-- Name: edit_request_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.edit_request_status AS ENUM (
    'pending',
    'approved',
    'denied',
    'cancelled',
    'expired'
);


--
-- Name: feature_flag_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.feature_flag_scope AS ENUM (
    'global',
    'account',
    'user'
);


--
-- Name: funds_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.funds_kind AS ENUM (
    'own',
    'loan'
);


--
-- Name: impersonation_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.impersonation_mode AS ENUM (
    'view',
    'edit'
);


--
-- Name: import_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.import_status AS ENUM (
    'mapped',
    'pending',
    'promoted',
    'rejected'
);


--
-- Name: invite_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.invite_status AS ENUM (
    'pending',
    'consumed',
    'revoked',
    'expired'
);


--
-- Name: label_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.label_category AS ENUM (
    'router',
    'lending',
    'bridge',
    'wallet',
    'exchange',
    'contract',
    'other'
);


--
-- Name: label_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.label_status AS ENUM (
    'proposed',
    'approved',
    'rejected'
);


--
-- Name: notification_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_channel AS ENUM (
    'email',
    'telegram'
);


--
-- Name: op_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.op_source AS ENUM (
    'manual',
    'import',
    'promoted'
);


--
-- Name: op_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.op_type AS ENUM (
    'buy',
    'sell',
    'swap',
    'transfer',
    'deposit',
    'withdraw',
    'fee',
    'open',
    'close',
    'loan',
    'loan_repay',
    'loan_take',
    'div',
    'other'
);


--
-- Name: payment_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_kind AS ENUM (
    'subscription',
    'refund',
    'trial',
    'one_time'
);


--
-- Name: payment_plan; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_plan AS ENUM (
    'trial',
    'monthly',
    'quarterly',
    'semiannual',
    'yearly',
    'lifetime',
    'custom'
);


--
-- Name: telegram_link_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.telegram_link_status AS ENUM (
    'pending',
    'linked',
    'revoked'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'admin',
    'user',
    'viewer'
);


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'pending',
    'blocked'
);


--
-- Name: value_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.value_mode AS ENUM (
    'auto',
    'manual'
);


--
-- Name: wallet_address_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.wallet_address_type AS ENUM (
    'evm',
    'solana',
    'tron',
    'btc',
    'other'
);


--
-- Name: wallet_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.wallet_kind AS ENUM (
    'internal',
    'external'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: __drizzle_migrations; Type: TABLE; Schema: drizzle; Owner: -
--

CREATE TABLE drizzle.__drizzle_migrations (
    id integer NOT NULL,
    hash text NOT NULL,
    created_at bigint
);


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE; Schema: drizzle; Owner: -
--

CREATE SEQUENCE drizzle.__drizzle_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: __drizzle_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: drizzle; Owner: -
--

ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNED BY drizzle.__drizzle_migrations.id;


--
-- Name: account_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_counters (
    account_id uuid NOT NULL,
    op_counter integer DEFAULT 0 NOT NULL,
    imp_counter integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    name text NOT NULL,
    owner_id uuid NOT NULL,
    seeded_from_legacy_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    description text,
    is_primary boolean DEFAULT false NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: address_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.address_labels (
    account_id uuid NOT NULL,
    address text NOT NULL,
    name text NOT NULL,
    category public.label_category NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    account_id uuid,
    provider character varying(40) NOT NULL,
    endpoint character varying(200) NOT NULL,
    http_status integer,
    duration_ms integer,
    cache_hit integer DEFAULT 0 NOT NULL,
    cost_estimate_usd numeric(12,6),
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    account_id uuid,
    action text NOT NULL,
    target text,
    payload jsonb,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    as_admin boolean DEFAULT false NOT NULL,
    target_user_id uuid,
    ip character varying(45),
    user_agent text
);


--
-- Name: auth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cg_id_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cg_id_overrides (
    account_id uuid NOT NULL,
    symbol text NOT NULL,
    coingecko_id text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chain_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chain_registry (
    chain_id integer NOT NULL,
    name text NOT NULL,
    fee_token text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    coingecko_platform text,
    default_rpc_hint text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: coingecko_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coingecko_registry (
    symbol text NOT NULL,
    coingecko_id text NOT NULL,
    name text,
    contract_addresses jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: community_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_labels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    address text NOT NULL,
    name text NOT NULL,
    category public.label_category NOT NULL,
    status public.label_status DEFAULT 'proposed'::public.label_status NOT NULL,
    proposed_by_id uuid,
    approved_by_id uuid,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: crypto_payment_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crypto_payment_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    network public.crypto_network NOT NULL,
    address text NOT NULL,
    derivation_index integer,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deleted_ops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deleted_ops (
    account_id uuid NOT NULL,
    legacy_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: edit_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edit_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_user_id uuid NOT NULL,
    admin_id uuid NOT NULL,
    account_id uuid,
    reason text,
    status public.edit_request_status DEFAULT 'pending'::public.edit_request_status NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    granted_until timestamp with time zone,
    approved_at timestamp with time zone,
    denied_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    scope public.feature_flag_scope NOT NULL,
    scope_ref_id uuid,
    enabled boolean DEFAULT false NOT NULL,
    payload jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: historical_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.historical_prices (
    symbol text NOT NULL,
    date date NOT NULL,
    price_usd numeric(28,8) NOT NULL,
    source text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: imported_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.imported_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text NOT NULL,
    account_id uuid NOT NULL,
    source text NOT NULL,
    chain_id integer NOT NULL,
    dedup_key text NOT NULL,
    wallet_name text NOT NULL,
    block_time bigint NOT NULL,
    mapped jsonb NOT NULL,
    raw jsonb NOT NULL,
    status public.import_status DEFAULT 'mapped'::public.import_status NOT NULL,
    promoted_to_operation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(320) NOT NULL,
    token_hash text NOT NULL,
    status public.invite_status DEFAULT 'pending'::public.invite_status NOT NULL,
    created_by_user_id uuid NOT NULL,
    consumed_by_user_id uuid,
    consumed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lp_pairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lp_pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    pair text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_subscriptions (
    user_id uuid NOT NULL,
    type text NOT NULL,
    channel public.notification_channel NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text NOT NULL,
    account_id uuid NOT NULL,
    date date NOT NULL,
    type public.op_type NOT NULL,
    source public.op_source DEFAULT 'manual'::public.op_source NOT NULL,
    from_name text,
    to_name text,
    cur1 text,
    amount1 numeric(38,18),
    cur2 text,
    amount2 numeric(38,18),
    rate numeric(28,8),
    avg_price numeric(28,8),
    price_usd numeric(28,8),
    pos_type text,
    funds public.funds_kind,
    loan_rate numeric(28,8),
    loan_rate_take numeric(28,8),
    loan_from_name text,
    loan_pos_legacy_id text,
    loan_ltv numeric(28,8),
    loan_liq_pct numeric(28,8),
    loan_liq_price numeric(28,8),
    loan_collateral_usd numeric(28,8),
    network text,
    commission_network text,
    close_token_amount numeric(38,18),
    direction text,
    comment text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    address_id uuid NOT NULL,
    network public.crypto_network NOT NULL,
    tx_hash text NOT NULL,
    from_address text,
    amount numeric(28,8) NOT NULL,
    confirmations integer DEFAULT 0 NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    credited_payment_id uuid,
    note text
);


--
-- Name: portfolio_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text NOT NULL,
    account_id uuid NOT NULL,
    date date NOT NULL,
    label text,
    is_manual text DEFAULT 'false'::text NOT NULL,
    metrics jsonb NOT NULL,
    positions jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: position_custom_cols; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.position_custom_cols (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: position_div_collects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.position_div_collects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    operation_legacy_id text NOT NULL,
    collected_at date NOT NULL,
    amount numeric(38,18) NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: position_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.position_meta (
    account_id uuid NOT NULL,
    operation_legacy_id text NOT NULL,
    operation_id uuid,
    current_value_mode public.value_mode DEFAULT 'auto'::public.value_mode NOT NULL,
    current_value numeric(28,8),
    dividends numeric(28,8) DEFAULT '0'::numeric NOT NULL,
    link text DEFAULT ''::text NOT NULL,
    comment text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: position_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.position_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_token_hash text NOT NULL,
    user_id uuid NOT NULL,
    user_agent text,
    ip text,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    impersonated_by_id uuid,
    impersonation_mode public.impersonation_mode,
    edit_request_id uuid,
    edit_granted_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telegram_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telegram_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    start_code_hash text NOT NULL,
    status public.telegram_link_status DEFAULT 'pending'::public.telegram_link_status NOT NULL,
    chat_id bigint,
    telegram_username text,
    linked_at timestamp with time zone,
    revoked_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    symbol text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind public.payment_kind NOT NULL,
    plan public.payment_plan NOT NULL,
    amount_usd numeric(28,8) DEFAULT '0'::numeric NOT NULL,
    horizon_months integer DEFAULT 0 NOT NULL,
    paid_at timestamp with time zone NOT NULL,
    period_end timestamp with time zone,
    refunded_payment_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    telegram_id bigint,
    telegram_username text,
    first_name text,
    last_name text,
    role public.user_role DEFAULT 'user'::public.user_role NOT NULL,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    notes text,
    active_account_id uuid,
    tracked_tickers text[] DEFAULT '{}'::text[] NOT NULL,
    billing_meta jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email text,
    password_hash text,
    name text,
    email_verified_at timestamp with time zone,
    last_login_at timestamp with time zone
);


--
-- Name: wallet_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallet_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    wallet_id uuid NOT NULL,
    address text NOT NULL,
    type public.wallet_address_type NOT NULL,
    chains integer[] DEFAULT '{}'::integer[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wallets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    kind public.wallet_kind DEFAULT 'external'::public.wallet_kind NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: __drizzle_migrations id; Type: DEFAULT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations ALTER COLUMN id SET DEFAULT nextval('drizzle.__drizzle_migrations_id_seq'::regclass);


--
-- Name: __drizzle_migrations __drizzle_migrations_pkey; Type: CONSTRAINT; Schema: drizzle; Owner: -
--

ALTER TABLE ONLY drizzle.__drizzle_migrations
    ADD CONSTRAINT __drizzle_migrations_pkey PRIMARY KEY (id);


--
-- Name: account_counters account_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_counters
    ADD CONSTRAINT account_counters_pkey PRIMARY KEY (account_id);


--
-- Name: accounts accounts_legacy_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_legacy_id_unique UNIQUE (legacy_id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: api_usage api_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: auth_tokens auth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_pkey PRIMARY KEY (id);


--
-- Name: auth_tokens auth_tokens_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: cg_id_overrides cg_id_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cg_id_overrides
    ADD CONSTRAINT cg_id_overrides_pkey PRIMARY KEY (account_id, symbol);


--
-- Name: chain_registry chain_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chain_registry
    ADD CONSTRAINT chain_registry_pkey PRIMARY KEY (chain_id);


--
-- Name: coingecko_registry coingecko_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coingecko_registry
    ADD CONSTRAINT coingecko_registry_pkey PRIMARY KEY (symbol);


--
-- Name: community_labels community_labels_address_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_labels
    ADD CONSTRAINT community_labels_address_unique UNIQUE (address);


--
-- Name: community_labels community_labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_labels
    ADD CONSTRAINT community_labels_pkey PRIMARY KEY (id);


--
-- Name: crypto_payment_addresses crypto_payment_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_payment_addresses
    ADD CONSTRAINT crypto_payment_addresses_pkey PRIMARY KEY (id);


--
-- Name: edit_requests edit_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);


--
-- Name: historical_prices historical_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.historical_prices
    ADD CONSTRAINT historical_prices_pkey PRIMARY KEY (symbol, date);


--
-- Name: imported_operations imported_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imported_operations
    ADD CONSTRAINT imported_operations_pkey PRIMARY KEY (id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: lp_pairs lp_pairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lp_pairs
    ADD CONSTRAINT lp_pairs_pkey PRIMARY KEY (id);


--
-- Name: notification_subscriptions notification_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_subscriptions
    ADD CONSTRAINT notification_subscriptions_pkey PRIMARY KEY (user_id, type, channel);


--
-- Name: operations operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations
    ADD CONSTRAINT operations_pkey PRIMARY KEY (id);


--
-- Name: payment_transactions payment_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_pkey PRIMARY KEY (id);


--
-- Name: portfolio_snapshots portfolio_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_snapshots
    ADD CONSTRAINT portfolio_snapshots_pkey PRIMARY KEY (id);


--
-- Name: position_custom_cols position_custom_cols_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_custom_cols
    ADD CONSTRAINT position_custom_cols_pkey PRIMARY KEY (id);


--
-- Name: position_div_collects position_div_collects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_div_collects
    ADD CONSTRAINT position_div_collects_pkey PRIMARY KEY (id);


--
-- Name: position_types position_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_types
    ADD CONSTRAINT position_types_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_session_token_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_session_token_hash_unique UNIQUE (session_token_hash);


--
-- Name: telegram_links telegram_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_pkey PRIMARY KEY (id);


--
-- Name: tokens tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_pkey PRIMARY KEY (id);


--
-- Name: user_payments user_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_payments
    ADD CONSTRAINT user_payments_pkey PRIMARY KEY (id);


--
-- Name: users users_legacy_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_legacy_id_unique UNIQUE (legacy_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: wallet_addresses wallet_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_addresses
    ADD CONSTRAINT wallet_addresses_pkey PRIMARY KEY (id);


--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);


--
-- Name: accounts_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_active_idx ON public.accounts USING btree (owner_id, archived_at);


--
-- Name: accounts_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_owner_idx ON public.accounts USING btree (owner_id);


--
-- Name: address_labels_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX address_labels_pk ON public.address_labels USING btree (account_id, address);


--
-- Name: api_usage_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_usage_created_idx ON public.api_usage USING btree (created_at);


--
-- Name: api_usage_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_usage_provider_idx ON public.api_usage USING btree (provider);


--
-- Name: api_usage_provider_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_usage_provider_time_idx ON public.api_usage USING btree (provider, created_at);


--
-- Name: api_usage_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_usage_user_id_idx ON public.api_usage USING btree (user_id);


--
-- Name: audit_log_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_action_idx ON public.audit_log USING btree (action);


--
-- Name: audit_log_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_actor_idx ON public.audit_log USING btree (actor_id);


--
-- Name: audit_log_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_occurred_idx ON public.audit_log USING btree (occurred_at);


--
-- Name: audit_log_target_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_target_user_idx ON public.audit_log USING btree (target_user_id);


--
-- Name: auth_tokens_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_tokens_expires_idx ON public.auth_tokens USING btree (expires_at);


--
-- Name: auth_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_tokens_user_idx ON public.auth_tokens USING btree (user_id);


--
-- Name: cg_id_overrides_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cg_id_overrides_account_idx ON public.cg_id_overrides USING btree (account_id);


--
-- Name: chain_registry_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chain_registry_enabled_idx ON public.chain_registry USING btree (enabled);


--
-- Name: coingecko_registry_coingecko_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX coingecko_registry_coingecko_id_idx ON public.coingecko_registry USING btree (coingecko_id);


--
-- Name: coingecko_registry_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coingecko_registry_name_idx ON public.coingecko_registry USING btree (name);


--
-- Name: crypto_payment_addresses_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crypto_payment_addresses_active_idx ON public.crypto_payment_addresses USING btree (active);


--
-- Name: crypto_payment_addresses_net_addr_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crypto_payment_addresses_net_addr_uq ON public.crypto_payment_addresses USING btree (network, address);


--
-- Name: crypto_payment_addresses_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crypto_payment_addresses_user_idx ON public.crypto_payment_addresses USING btree (user_id);


--
-- Name: deleted_ops_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deleted_ops_pk ON public.deleted_ops USING btree (account_id, legacy_id);


--
-- Name: edit_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX edit_requests_status_idx ON public.edit_requests USING btree (status);


--
-- Name: edit_requests_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX edit_requests_target_idx ON public.edit_requests USING btree (target_user_id);


--
-- Name: feature_flags_key_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feature_flags_key_scope_idx ON public.feature_flags USING btree (key, scope, scope_ref_id);


--
-- Name: historical_prices_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX historical_prices_date_idx ON public.historical_prices USING btree (date);


--
-- Name: imported_operations_dedup_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX imported_operations_dedup_uq ON public.imported_operations USING btree (account_id, dedup_key);


--
-- Name: imported_operations_legacy_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX imported_operations_legacy_uq ON public.imported_operations USING btree (account_id, legacy_id);


--
-- Name: imported_operations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX imported_operations_status_idx ON public.imported_operations USING btree (status);


--
-- Name: invites_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invites_email_idx ON public.invites USING btree (email);


--
-- Name: invites_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invites_expires_idx ON public.invites USING btree (expires_at);


--
-- Name: invites_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invites_status_idx ON public.invites USING btree (status);


--
-- Name: invites_token_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invites_token_hash_uq ON public.invites USING btree (token_hash);


--
-- Name: lp_pairs_account_pair_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lp_pairs_account_pair_uq ON public.lp_pairs USING btree (account_id, pair);


--
-- Name: notification_subs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_subs_user_idx ON public.notification_subscriptions USING btree (user_id);


--
-- Name: operations_account_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operations_account_date_idx ON public.operations USING btree (account_id, date);


--
-- Name: operations_account_legacy_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operations_account_legacy_uq ON public.operations USING btree (account_id, legacy_id);


--
-- Name: operations_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operations_type_idx ON public.operations USING btree (type);


--
-- Name: payment_transactions_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_transactions_address_idx ON public.payment_transactions USING btree (address_id);


--
-- Name: payment_transactions_net_hash_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_transactions_net_hash_uq ON public.payment_transactions USING btree (network, tx_hash);


--
-- Name: payment_transactions_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_transactions_observed_idx ON public.payment_transactions USING btree (observed_at);


--
-- Name: portfolio_snapshots_legacy_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portfolio_snapshots_legacy_uq ON public.portfolio_snapshots USING btree (account_id, legacy_id);


--
-- Name: position_meta_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX position_meta_pk ON public.position_meta USING btree (account_id, operation_legacy_id);


--
-- Name: position_types_account_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX position_types_account_name_uq ON public.position_types USING btree (account_id, name);


--
-- Name: projects_account_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX projects_account_name_uq ON public.projects USING btree (account_id, name);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: telegram_links_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_links_chat_idx ON public.telegram_links USING btree (chat_id);


--
-- Name: telegram_links_start_code_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX telegram_links_start_code_uq ON public.telegram_links USING btree (start_code_hash);


--
-- Name: telegram_links_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX telegram_links_user_idx ON public.telegram_links USING btree (user_id);


--
-- Name: tokens_account_symbol_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tokens_account_symbol_uq ON public.tokens USING btree (account_id, symbol);


--
-- Name: user_payments_user_paid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_payments_user_paid_idx ON public.user_payments USING btree (user_id, paid_at);


--
-- Name: users_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_uq ON public.users USING btree (email);


--
-- Name: users_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_role_idx ON public.users USING btree (role);


--
-- Name: users_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_status_idx ON public.users USING btree (status);


--
-- Name: users_telegram_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_telegram_id_uq ON public.users USING btree (telegram_id);


--
-- Name: wallet_addresses_addr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wallet_addresses_addr_idx ON public.wallet_addresses USING btree (address);


--
-- Name: wallet_addresses_wallet_addr_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallet_addresses_wallet_addr_uq ON public.wallet_addresses USING btree (wallet_id, address);


--
-- Name: wallets_account_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wallets_account_name_uq ON public.wallets USING btree (account_id, name);


--
-- Name: account_counters account_counters_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_counters
    ADD CONSTRAINT account_counters_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_owner_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_owner_id_users_id_fk FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: address_labels address_labels_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.address_labels
    ADD CONSTRAINT address_labels_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: api_usage api_usage_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: api_usage api_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_actor_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_actor_id_users_id_fk FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: auth_tokens auth_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_tokens
    ADD CONSTRAINT auth_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: cg_id_overrides cg_id_overrides_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cg_id_overrides
    ADD CONSTRAINT cg_id_overrides_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: community_labels community_labels_approved_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_labels
    ADD CONSTRAINT community_labels_approved_by_id_users_id_fk FOREIGN KEY (approved_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: community_labels community_labels_proposed_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_labels
    ADD CONSTRAINT community_labels_proposed_by_id_users_id_fk FOREIGN KEY (proposed_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: crypto_payment_addresses crypto_payment_addresses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crypto_payment_addresses
    ADD CONSTRAINT crypto_payment_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: deleted_ops deleted_ops_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deleted_ops
    ADD CONSTRAINT deleted_ops_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: edit_requests edit_requests_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: edit_requests edit_requests_admin_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_admin_id_users_id_fk FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: edit_requests edit_requests_target_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_target_user_id_users_id_fk FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: imported_operations imported_operations_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imported_operations
    ADD CONSTRAINT imported_operations_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: imported_operations imported_operations_promoted_to_operation_id_operations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.imported_operations
    ADD CONSTRAINT imported_operations_promoted_to_operation_id_operations_id_fk FOREIGN KEY (promoted_to_operation_id) REFERENCES public.operations(id) ON DELETE SET NULL;


--
-- Name: invites invites_consumed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_consumed_by_user_id_fkey FOREIGN KEY (consumed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invites invites_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: lp_pairs lp_pairs_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lp_pairs
    ADD CONSTRAINT lp_pairs_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: notification_subscriptions notification_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_subscriptions
    ADD CONSTRAINT notification_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: operations operations_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations
    ADD CONSTRAINT operations_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: payment_transactions payment_transactions_address_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_address_id_fkey FOREIGN KEY (address_id) REFERENCES public.crypto_payment_addresses(id) ON DELETE CASCADE;


--
-- Name: payment_transactions payment_transactions_credited_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_credited_payment_id_fkey FOREIGN KEY (credited_payment_id) REFERENCES public.user_payments(id) ON DELETE SET NULL;


--
-- Name: portfolio_snapshots portfolio_snapshots_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_snapshots
    ADD CONSTRAINT portfolio_snapshots_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: position_custom_cols position_custom_cols_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_custom_cols
    ADD CONSTRAINT position_custom_cols_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: position_div_collects position_div_collects_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_div_collects
    ADD CONSTRAINT position_div_collects_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: position_meta position_meta_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_meta
    ADD CONSTRAINT position_meta_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: position_meta position_meta_operation_id_operations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_meta
    ADD CONSTRAINT position_meta_operation_id_operations_id_fk FOREIGN KEY (operation_id) REFERENCES public.operations(id) ON DELETE CASCADE;


--
-- Name: position_types position_types_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.position_types
    ADD CONSTRAINT position_types_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: projects projects_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_impersonated_by_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_impersonated_by_id_users_id_fk FOREIGN KEY (impersonated_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: telegram_links telegram_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telegram_links
    ADD CONSTRAINT telegram_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tokens tokens_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: user_payments user_payments_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_payments
    ADD CONSTRAINT user_payments_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: wallet_addresses wallet_addresses_wallet_id_wallets_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallet_addresses
    ADD CONSTRAINT wallet_addresses_wallet_id_wallets_id_fk FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE CASCADE;


--
-- Name: wallets wallets_account_id_accounts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wallets
    ADD CONSTRAINT wallets_account_id_accounts_id_fk FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


