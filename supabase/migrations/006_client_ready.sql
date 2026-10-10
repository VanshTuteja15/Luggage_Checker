-- ============================================================
-- LuggageTracker — migration 006 (client-ready release)
--
-- Morning email (settings, chosen products, run log), product
-- groups, web estimates, stock status and broken-link tracking.
-- See MASTER_PROMPT_V2.md §5.
--
-- Additive and idempotent: creates new objects or adds nullable /
-- defaulted columns, never drops or rewrites data. Safe to run again.
-- Run after 005, in the Supabase SQL Editor.
-- ============================================================

-- ============================================================
-- Stock status on the tracking workflow's offers (R6)
--
-- retailer_offers.in_stock is a boolean that has always defaulted to
-- true, so it can't tell "in stock" from "nobody said". The engine
-- bridge now also writes the three-state value it read. NULL = only
-- the old boolean is known (rows written before this migration, or by
-- the web-research refresh).
-- ============================================================

ALTER TABLE retailer_offers ADD COLUMN IF NOT EXISTS availability TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'retailer_offers_availability_check') THEN
    ALTER TABLE retailer_offers
      ADD CONSTRAINT retailer_offers_availability_check
      CHECK (availability IS NULL OR availability IN ('in_stock', 'out_of_stock', 'unknown'));
  END IF;
END $$;
