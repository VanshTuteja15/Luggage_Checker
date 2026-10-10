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

-- ============================================================
-- Web estimates (R3)
--
-- An accepted estimate is an observation with adapter 'web_estimate'
-- (observations.adapter is free text; availability and evidence
-- columns already exist). Below: the paid-for search results (cache,
-- so a repeat within 6-12 h costs nothing), credits spent per local
-- day and purpose (the budget planner), and rejected results with
-- their reasons (Store status → Technical details). Never shown.
-- ============================================================

CREATE TABLE IF NOT EXISTS web_estimate_searches (
  cache_key   TEXT PRIMARY KEY CHECK (char_length(cache_key) BETWEEN 3 AND 80),
  query       TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('interactive', 'email')),
  results     JSONB NOT NULL DEFAULT '[]',
  credits     INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  searched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_estimate_searches_expires ON web_estimate_searches(expires_at);

CREATE TABLE IF NOT EXISTS web_estimate_spend (
  local_date DATE NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('interactive', 'email')),
  credits    INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  PRIMARY KEY (local_date, purpose)
);

CREATE TABLE IF NOT EXISTS web_estimate_rejections (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  query     TEXT NOT NULL,
  url       TEXT NOT NULL,
  title     TEXT,
  snippet   TEXT CHECK (snippet IS NULL OR char_length(snippet) <= 300),
  price     NUMERIC(10, 2),
  reasons   JSONB NOT NULL DEFAULT '[]',
  found_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_web_estimate_rejections_found ON web_estimate_rejections(found_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON web_estimate_searches, web_estimate_spend, web_estimate_rejections FROM anon';
  END IF;
END $$;

ALTER TABLE web_estimate_searches   ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_estimate_spend      ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_estimate_rejections ENABLE ROW LEVEL SECURITY;

-- Written by the engine (server-side DATABASE_URL); admins may read.
DROP POLICY IF EXISTS "Admins read estimate searches" ON web_estimate_searches;
CREATE POLICY "Admins read estimate searches" ON web_estimate_searches FOR SELECT TO authenticated USING (is_admin());
DROP POLICY IF EXISTS "Admins read estimate spend" ON web_estimate_spend;
CREATE POLICY "Admins read estimate spend" ON web_estimate_spend FOR SELECT TO authenticated USING (is_admin());
DROP POLICY IF EXISTS "Admins read estimate rejections" ON web_estimate_rejections;
CREATE POLICY "Admins read estimate rejections" ON web_estimate_rejections FOR SELECT TO authenticated USING (is_admin());

-- Estimates never extend verified price history (R3.1): the range
-- collapse skips them, so price_ranges stays "prices we read".
CREATE OR REPLACE FUNCTION collapse_observation_into_range()
RETURNS TRIGGER AS $$
DECLARE
  latest price_ranges%ROWTYPE;
BEGIN
  IF NEW.outcome = 'rejected' OR NEW.price IS NULL OR NEW.adapter = 'web_estimate' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO latest FROM price_ranges
  WHERE listing_id = NEW.listing_id
  ORDER BY last_seen_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND NEW.fetched_at < latest.last_seen_at THEN
    RETURN NEW;
  END IF;

  IF FOUND AND latest.price = NEW.price AND latest.availability = NEW.availability THEN
    UPDATE price_ranges
       SET last_seen_at = NEW.fetched_at,
           observation_count = observation_count + 1,
           last_observation_id = NEW.id
     WHERE id = latest.id;
  ELSE
    INSERT INTO price_ranges (listing_id, price, currency, availability, first_seen_at, last_seen_at, first_observation_id, last_observation_id)
    VALUES (NEW.listing_id, NEW.price, 'CAD', NEW.availability, NEW.fetched_at, NEW.fetched_at, NEW.id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Retention: also expired estimate searches and old rejections (same 180-day policy).
CREATE OR REPLACE FUNCTION engine_retention(p_days INTEGER DEFAULT 180)
RETURNS JSONB AS $$
DECLARE
  attempts_removed   INTEGER;
  events_removed     INTEGER;
  searches_removed   INTEGER := 0;
  rejections_removed INTEGER := 0;
BEGIN
  IF p_days < 30 THEN
    RAISE EXCEPTION 'engine_retention: keep at least 30 days';
  END IF;
  DELETE FROM fetch_attempts WHERE started_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS attempts_removed = ROW_COUNT;
  DELETE FROM session_events WHERE created_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS events_removed = ROW_COUNT;
  IF to_regclass('public.web_estimate_searches') IS NOT NULL THEN
    DELETE FROM web_estimate_searches WHERE expires_at < now() - interval '1 day';
    GET DIAGNOSTICS searches_removed = ROW_COUNT;
  END IF;
  IF to_regclass('public.web_estimate_rejections') IS NOT NULL THEN
    DELETE FROM web_estimate_rejections WHERE found_at < now() - make_interval(days => p_days);
    GET DIAGNOSTICS rejections_removed = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object(
    'fetch_attempts', attempts_removed,
    'session_events', events_removed,
    'estimate_searches', searches_removed,
    'estimate_rejections', rejections_removed
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION engine_retention(INTEGER) FROM PUBLIC;
