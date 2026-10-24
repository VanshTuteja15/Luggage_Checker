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

-- ============================================================
-- Morning email (R1)
--
-- One settings row per account, the products chosen for the email
-- (in order), and a log of every run. A daily run is claimed before
-- anything is sent: the partial unique index allows one daily row per
-- account and local date, so retries and parallel ticks never send
-- twice (R1.6). Untracking a product removes it from the email (R1.3).
-- ============================================================

CREATE TABLE IF NOT EXISTS email_digest_settings (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  send_time  TIME NOT NULL DEFAULT '09:00',
  timezone   TEXT NOT NULL DEFAULT 'America/Edmonton',
  recipients TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(recipients) <= 10),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_digest_products (
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tracked_product_id UUID NOT NULL REFERENCES tracked_products(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tracked_product_id)
);

CREATE TABLE IF NOT EXISTS email_digest_runs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_date    DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('daily', 'test')),
  status        TEXT NOT NULL DEFAULT 'claimed'
                CHECK (status IN ('claimed', 'preparing', 'sending', 'sent', 'partial', 'failed', 'missed', 'skipped')),
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  prepared_at   TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  -- Per address: { address, status: 'sent' | 'failed', providerId, error, attempts }.
  recipients    JSONB NOT NULL DEFAULT '[]',
  product_count INTEGER NOT NULL DEFAULT 0 CHECK (product_count >= 0),
  -- What was sent: subject and the summary lines (not the whole email).
  snapshot      JSONB,
  error         TEXT,
  -- Plain sentences for the log ("The scheduler was late today").
  notes         JSONB NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS email_digest_runs_one_daily
  ON email_digest_runs (user_id, local_date) WHERE kind = 'daily';
CREATE INDEX IF NOT EXISTS idx_email_digest_runs_user_date
  ON email_digest_runs (user_id, local_date DESC);
CREATE INDEX IF NOT EXISTS idx_email_digest_runs_sent
  ON email_digest_runs (sent_at DESC) WHERE sent_at IS NOT NULL;

-- ============================================================
-- Product groups (R7.2)
-- ============================================================

CREATE TABLE IF NOT EXISTS product_groups (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_groups_user_name ON product_groups (user_id, lower(name));

CREATE TABLE IF NOT EXISTS product_group_members (
  group_id           UUID NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE,
  tracked_product_id UUID NOT NULL REFERENCES tracked_products(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, tracked_product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_group_members_tracked ON product_group_members (tracked_product_id);

-- ============================================================
-- Broken store links (R7.4)
--
-- A known product page that answers 404/410 twice in a row is marked
-- 'broken' (Store status, email summary); a good read resets it.
-- ============================================================

ALTER TABLE listings ADD COLUMN IF NOT EXISTS link_status   TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS link_failures INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listings_link_status_check') THEN
    ALTER TABLE listings
      ADD CONSTRAINT listings_link_status_check CHECK (link_status IN ('ok', 'broken'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'listings_link_failures_check') THEN
    ALTER TABLE listings
      ADD CONSTRAINT listings_link_failures_check CHECK (link_failures >= 0);
  END IF;
END $$;

-- ============================================================
-- Row Level Security for the email and groups
--
-- The owner reads and writes their own rows. Daily runs are written
-- by the scheduler (service role) only; the owner may log test sends.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON email_digest_settings, email_digest_products, email_digest_runs, product_groups, product_group_members FROM anon';
  END IF;
END $$;

ALTER TABLE email_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_digest_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_digest_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owner manages email settings" ON email_digest_settings;
CREATE POLICY "Owner manages email settings" ON email_digest_settings FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Owner manages email products" ON email_digest_products;
CREATE POLICY "Owner manages email products" ON email_digest_products FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM tracked_products t WHERE t.id = tracked_product_id AND t.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Owner reads email runs" ON email_digest_runs;
CREATE POLICY "Owner reads email runs" ON email_digest_runs FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Owner logs test sends" ON email_digest_runs;
CREATE POLICY "Owner logs test sends" ON email_digest_runs FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND kind = 'test');
DROP POLICY IF EXISTS "Owner updates test sends" ON email_digest_runs;
CREATE POLICY "Owner updates test sends" ON email_digest_runs FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND kind = 'test') WITH CHECK (user_id = auth.uid() AND kind = 'test');

DROP POLICY IF EXISTS "Owner manages groups" ON product_groups;
CREATE POLICY "Owner manages groups" ON product_groups FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Owner manages group members" ON product_group_members;
CREATE POLICY "Owner manages group members" ON product_group_members FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM product_groups g WHERE g.id = group_id AND g.user_id = auth.uid()))
  WITH CHECK (
    EXISTS (SELECT 1 FROM product_groups g WHERE g.id = group_id AND g.user_id = auth.uid())
    AND EXISTS (SELECT 1 FROM tracked_products t WHERE t.id = tracked_product_id AND t.user_id = auth.uid())
  );
