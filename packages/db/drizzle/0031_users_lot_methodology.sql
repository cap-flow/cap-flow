-- UCB server port: persist the user's lot-consumption methodology server-side so
-- the shadow compute follows the user's UI choice (FIFO/LIFO/WAC/HIFO). NULL =
-- FIFO default. Additive, nullable — safe on prod.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lot_methodology" text;
