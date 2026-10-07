-- ============================================================
-- LuggageTracker — migration 004
-- Price engine: source registry, identity graph, listings index,
-- research sessions, append-only fetch attempts and observations,
-- price ranges, identity review queue, feature flags, admin role.
--
-- Additive and idempotent: creates new objects only, never alters or
-- drops an existing table, safe to run again. Run after 000 (or
-- 001 + 002) and 003, in the Supabase SQL Editor.
--
-- The existing tracking tables (products, retailer_offers,
-- price_history, tracked_products) are NOT touched. The engine's own
-- product identities live in catalog_* tables.
-- ============================================================

-- ============================================================
-- Admin role
-- ============================================================

CREATE TABLE IF NOT EXISTS app_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- SECURITY DEFINER so policies can call it without granting read on app_admins.
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM app_admins WHERE user_id = auth.uid());
$$;

-- ============================================================
-- Feature flags
-- ============================================================

CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9_.-]{3,100}$'),
  enabled     BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- ============================================================
-- Source registry (seeded from src/lib/engine/registry/seed.ts)
-- ============================================================

CREATE TABLE IF NOT EXISTS sources (
  id                   TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,60}$'),
  name                 TEXT NOT NULL,
  retailer_label       TEXT NOT NULL,
  category             TEXT NOT NULL CHECK (category IN ('brand_direct', 'specialty_retailer', 'major_retailer', 'marketplace')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'defunct')),
  platform             TEXT,
  allowed_domains      TEXT[] NOT NULL DEFAULT '{}',
  fetch_hosts          TEXT[] NOT NULL DEFAULT '{}',
  market_host          TEXT,
  market_path_prefix   TEXT,
  currency             TEXT NOT NULL DEFAULT 'CAD' CHECK (currency = 'CAD'),
  live_class           TEXT NOT NULL CHECK (live_class IN ('official_api', 'direct_http', 'needs_js', 'blocked', 'not_permitted', 'none', 'unknown', 'defunct')),
  permission           TEXT NOT NULL CHECK (permission IN ('sanctioned', 'allowed', 'unclear', 'restricted', 'forbidden', 'not_applicable')),
  terms                JSONB NOT NULL DEFAULT '{}',
  robots               JSONB NOT NULL DEFAULT '{}',
  crawl_delay_sec      NUMERIC(6, 2) NOT NULL DEFAULT 3 CHECK (crawl_delay_sec >= 1),
  visit_window         JSONB,
  ucp_endpoint         TEXT,
  identity_quality     JSONB NOT NULL DEFAULT '{}',
  routes               JSONB NOT NULL DEFAULT '[]',
  link_only_search_url TEXT,
  domain_warnings      TEXT[] NOT NULL DEFAULT '{}',
  evidence             JSONB NOT NULL DEFAULT '{}',
  enabled              BOOLEAN NOT NULL DEFAULT true,
  -- Circuit breaker: opened after repeated blocks, so we stop knocking.
  circuit_state        TEXT NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  circuit_opened_at    TIMESTAMPTZ,
  circuit_reason       TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  seed_version         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Identity graph: products → variants → identifiers
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category     TEXT NOT NULL DEFAULT 'luggage',
  brand        TEXT,
  line         TEXT,
  name         TEXT NOT NULL,
  size_class   TEXT,
  attributes   JSONB NOT NULL DEFAULT '{}',
  -- brand|line|size_class: two active products never share it.
  identity_key TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged')),
  merged_into  UUID REFERENCES catalog_products(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_products_identity_key
  ON catalog_products(identity_key) WHERE status = 'active' AND identity_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS catalog_variants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  colour      TEXT,
  colour_code TEXT,
  title       TEXT,
  image_url   TEXT,
  attributes  JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_variants_product ON catalog_variants(product_id);

CREATE TABLE IF NOT EXISTS catalog_identifiers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES catalog_variants(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('gtin', 'mpn', 'model', 'store_sku')),
  value      TEXT NOT NULL CHECK (char_length(value) BETWEEN 1 AND 120),
  -- Store SKUs are only unique within their store.
  source_id  TEXT REFERENCES sources(id) ON DELETE CASCADE,
  scope      TEXT GENERATED ALWAYS AS (COALESCE(source_id, '')) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'store_sku' OR source_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_identifiers ON catalog_identifiers(kind, value, scope);
CREATE INDEX IF NOT EXISTS idx_catalog_identifiers_product ON catalog_identifiers(product_id);

-- ============================================================
-- Listings: one store page per product/variant, with full-text index
-- ============================================================

CREATE TABLE IF NOT EXISTS listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- https product URL on an allowed domain, or feed:/manual: for rows
  -- that have no public page.
  url           TEXT NOT NULL CHECK (url ~ '^(https://|feed:|manual:)'),
  external_id   TEXT,
  title         TEXT NOT NULL,
  brand         TEXT,
  size_class    TEXT,
  colour        TEXT,
  identifiers   JSONB NOT NULL DEFAULT '[]',
  image_url     TEXT,
  product_id    UUID REFERENCES catalog_products(id) ON DELETE SET NULL,
  variant_id    UUID REFERENCES catalog_variants(id) ON DELETE SET NULL,
  discovered_via TEXT NOT NULL CHECK (discovered_via IN ('sitemap', 'ucp', 'feed', 'tavily', 'manual', 'live_search', 'seed')),
  lastmod       TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  active        BOOLEAN NOT NULL DEFAULT true,
  -- 'simple' config: brand and model words must not be stemmed, and the
  -- index serves English and French titles alike.
  search_tsv    TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', COALESCE(brand, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(title, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(identifiers::text, '')), 'C')
  ) STORED,
  UNIQUE (source_id, url)
);

CREATE INDEX IF NOT EXISTS idx_listings_search   ON listings USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_listings_product  ON listings(product_id);
CREATE INDEX IF NOT EXISTS idx_listings_source   ON listings(source_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_ext      ON listings(source_id, external_id);

-- ============================================================
-- Research sessions and their event stream
-- ============================================================

CREATE TABLE IF NOT EXISTS research_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  query             TEXT NOT NULL CHECK (char_length(query) BETWEEN 1 AND 200),
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'cancelled', 'failed')),
  parent_session_id UUID REFERENCES research_sessions(id) ON DELETE SET NULL,
  store_ids         TEXT[],
  deadline_ms       INTEGER NOT NULL DEFAULT 11000 CHECK (deadline_ms BETWEEN 1000 AND 30000),
  mode              TEXT NOT NULL DEFAULT 'worker' CHECK (mode IN ('worker', 'inline', 'cron', 'shadow')),
  answer            JSONB,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON research_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_created      ON research_sessions(created_at DESC);

CREATE TABLE IF NOT EXISTS session_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  source_id  TEXT,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

-- ============================================================
-- Append-only evidence: fetch attempts and observations
-- ============================================================

CREATE TABLE IF NOT EXISTS fetch_attempts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     TEXT REFERENCES sources(id) ON DELETE SET NULL,
  adapter       TEXT NOT NULL,
  url           TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'GET',
  status        INTEGER,
  outcome       TEXT NOT NULL,
  duration_ms   INTEGER,
  bytes         INTEGER,
  error         TEXT,
  cache_age_sec INTEGER,
  session_id    UUID REFERENCES research_sessions(id) ON DELETE SET NULL,
  job_id        TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fetch_attempts_source ON fetch_attempts(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetch_attempts_failed ON fetch_attempts(started_at DESC) WHERE outcome <> 'ok';

CREATE TABLE IF NOT EXISTS observations (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id        UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  adapter           TEXT NOT NULL,
  price             NUMERIC(10, 2),
  list_price        NUMERIC(10, 2),
  currency          TEXT,
  availability      TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('in_stock', 'out_of_stock', 'preorder', 'backorder', 'unknown')),
  seller            TEXT,
  condition         TEXT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('accepted', 'low_confidence', 'rejected')),
  confidence        NUMERIC(4, 3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  validation        JSONB NOT NULL DEFAULT '{}',
  evidence          JSONB NOT NULL DEFAULT '{}',
  extractor_version TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  fetched_at        TIMESTAMPTZ NOT NULL,
  as_of             TIMESTAMPTZ,
  session_id        UUID REFERENCES research_sessions(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A price that is shown must be a real, positive CAD amount. Rejected
  -- readings are kept as evidence of what the source said.
  CHECK (outcome = 'rejected' OR (price > 0 AND currency = 'CAD'))
);

CREATE INDEX IF NOT EXISTS idx_observations_listing ON observations(listing_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_rejected ON observations(fetched_at DESC) WHERE outcome = 'rejected';

-- Append-only: rows may be deleted by the retention job, never rewritten.
CREATE OR REPLACE FUNCTION forbid_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS observations_append_only ON observations;
CREATE TRIGGER observations_append_only BEFORE UPDATE ON observations
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

DROP TRIGGER IF EXISTS fetch_attempts_append_only ON fetch_attempts;
CREATE TRIGGER fetch_attempts_append_only BEFORE UPDATE ON fetch_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- ============================================================
-- Price ranges: unchanged prices collapsed for history
-- ============================================================

CREATE TABLE IF NOT EXISTS price_ranges (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id           UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price                NUMERIC(10, 2) NOT NULL CHECK (price > 0),
  currency             TEXT NOT NULL DEFAULT 'CAD' CHECK (currency = 'CAD'),
  availability         TEXT NOT NULL DEFAULT 'unknown',
  first_seen_at        TIMESTAMPTZ NOT NULL,
  last_seen_at         TIMESTAMPTZ NOT NULL,
  observation_count    INTEGER NOT NULL DEFAULT 1,
  first_observation_id BIGINT,
  last_observation_id  BIGINT
);

CREATE INDEX IF NOT EXISTS idx_price_ranges_listing ON price_ranges(listing_id, last_seen_at DESC);

-- Every shown observation extends the latest range when nothing changed,
-- or opens a new one. Out-of-order (older) readings never reopen history.
CREATE OR REPLACE FUNCTION collapse_observation_into_range()
RETURNS TRIGGER AS $$
DECLARE
  latest price_ranges%ROWTYPE;
BEGIN
  IF NEW.outcome = 'rejected' OR NEW.price IS NULL THEN
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

DROP TRIGGER IF EXISTS observations_collapse_range ON observations;
CREATE TRIGGER observations_collapse_range AFTER INSERT ON observations
  FOR EACH ROW EXECUTE FUNCTION collapse_observation_into_range();

-- ============================================================
-- Identity review queue
-- ============================================================

CREATE TABLE IF NOT EXISTS identity_review (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id           UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  candidate_product_id UUID REFERENCES catalog_products(id) ON DELETE CASCADE,
  score                NUMERIC(5, 3),
  reasons              JSONB NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  decided_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_review_pending
  ON identity_review(listing_id, COALESCE(candidate_product_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'pending';

-- ============================================================
-- Feeds (dealer price lists, affiliate feeds)
-- ============================================================

CREATE TABLE IF NOT EXISTS feed_imports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  format      TEXT NOT NULL CHECK (format IN ('csv', 'json')),
  as_of       DATE NOT NULL,
  row_count   INTEGER NOT NULL DEFAULT 0,
  accepted    INTEGER NOT NULL DEFAULT 0,
  rejected    INTEGER NOT NULL DEFAULT 0,
  imported_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Housekeeping
-- ============================================================

-- Reuses update_updated_at() from migration 000/001 when present.
CREATE OR REPLACE FUNCTION engine_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sources_updated_at ON sources;
CREATE TRIGGER sources_updated_at BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION engine_touch_updated_at();

DROP TRIGGER IF EXISTS catalog_products_updated_at ON catalog_products;
CREATE TRIGGER catalog_products_updated_at BEFORE UPDATE ON catalog_products
  FOR EACH ROW EXECUTE FUNCTION engine_touch_updated_at();

-- Health per source over the last 24 h and 7 days.
CREATE OR REPLACE VIEW source_health AS
SELECT
  s.id AS source_id,
  s.retailer_label,
  s.live_class,
  s.permission,
  s.circuit_state,
  s.circuit_reason,
  COUNT(f.id) FILTER (WHERE f.started_at > now() - interval '24 hours')                                              AS attempts_24h,
  COUNT(f.id) FILTER (WHERE f.started_at > now() - interval '24 hours' AND f.outcome = 'ok')                         AS ok_24h,
  COUNT(f.id) FILTER (WHERE f.started_at > now() - interval '24 hours' AND f.outcome IN ('blocked', 'challenge', 'rate_limited')) AS blocked_24h,
  COUNT(f.id) FILTER (WHERE f.started_at > now() - interval '7 days')                                                AS attempts_7d,
  COUNT(f.id) FILTER (WHERE f.started_at > now() - interval '7 days' AND f.outcome = 'ok')                           AS ok_7d,
  COUNT(f.id) FILTER (WHERE f.started_at > now() - interval '7 days' AND f.outcome IN ('blocked', 'challenge', 'rate_limited')) AS blocked_7d,
  MAX(f.started_at) FILTER (WHERE f.outcome = 'ok')                                                                  AS last_ok_at,
  MAX(f.started_at) FILTER (WHERE f.outcome IN ('blocked', 'challenge', 'rate_limited'))                             AS last_block_at
FROM sources s
LEFT JOIN fetch_attempts f ON f.source_id = s.id AND f.started_at > now() - interval '7 days'
GROUP BY s.id;

-- Retention: evidence is kept 180 days, then removed in batches.
CREATE OR REPLACE FUNCTION engine_retention(p_days INTEGER DEFAULT 180)
RETURNS JSONB AS $$
DECLARE
  attempts_removed INTEGER;
  events_removed   INTEGER;
BEGIN
  IF p_days < 30 THEN
    RAISE EXCEPTION 'engine_retention: keep at least 30 days';
  END IF;
  DELETE FROM fetch_attempts WHERE started_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS attempts_removed = ROW_COUNT;
  DELETE FROM session_events WHERE created_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS events_removed = ROW_COUNT;
  RETURN jsonb_build_object('fetch_attempts', attempts_removed, 'session_events', events_removed);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION engine_retention(INTEGER) FROM PUBLIC;

-- ============================================================
-- Row Level Security
--
-- Reference data (sources, flags, catalog, listings, observations,
-- price ranges) is readable by any signed-in user and written only by
-- the engine (service role / worker) or admins. Research sessions and
-- their events belong to the user who started them.
-- ============================================================

ALTER TABLE app_admins          ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources             ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_variants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE fetch_attempts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_ranges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_review     ENABLE ROW LEVEL SECURITY;
ALTER TABLE feed_imports        ENABLE ROW LEVEL SECURITY;

-- app_admins: admins can see who else is an admin; changes are SQL-only.
DROP POLICY IF EXISTS "Admins read admins" ON app_admins;
CREATE POLICY "Admins read admins" ON app_admins FOR SELECT TO authenticated USING (is_admin());

-- Shared reference data: read for signed-in users, write for admins.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['feature_flags', 'sources', 'catalog_products', 'catalog_variants', 'catalog_identifiers', 'listings']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Authenticated read %1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "Authenticated read %1$s" ON %1$I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS "Admins write %1$s" ON %1$I', t);
    EXECUTE format('CREATE POLICY "Admins write %1$s" ON %1$I FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin())', t);
  END LOOP;
END $$;

-- Prices are public reference data; only the engine writes them.
DROP POLICY IF EXISTS "Authenticated read observations" ON observations;
CREATE POLICY "Authenticated read observations" ON observations FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated read price ranges" ON price_ranges;
CREATE POLICY "Authenticated read price ranges" ON price_ranges FOR SELECT TO authenticated USING (true);

-- Operational detail: admins only.
DROP POLICY IF EXISTS "Admins read fetch attempts" ON fetch_attempts;
CREATE POLICY "Admins read fetch attempts" ON fetch_attempts FOR SELECT TO authenticated USING (is_admin());
DROP POLICY IF EXISTS "Admins manage identity review" ON identity_review;
CREATE POLICY "Admins manage identity review" ON identity_review FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS "Admins manage feeds" ON feed_imports;
CREATE POLICY "Admins manage feeds" ON feed_imports FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- Research sessions: your own (admins see all, for timings).
DROP POLICY IF EXISTS "Own research sessions" ON research_sessions;
CREATE POLICY "Own research sessions" ON research_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR is_admin());
DROP POLICY IF EXISTS "Start own research sessions" ON research_sessions;
CREATE POLICY "Start own research sessions" ON research_sessions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Session events: readable by the session's owner (this is what Realtime
-- checks before delivering an event to the browser).
DROP POLICY IF EXISTS "Own session events" ON session_events;
CREATE POLICY "Own session events" ON session_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM research_sessions s
    WHERE s.id = session_events.session_id AND (s.user_id = auth.uid() OR is_admin())
  ));

-- The public (anon) key never reaches engine data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON app_admins, feature_flags, sources, catalog_products, catalog_variants, catalog_identifiers, listings, research_sessions, session_events, fetch_attempts, observations, price_ranges, identity_review, feed_imports FROM anon';
    EXECUTE 'REVOKE ALL ON source_health FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    -- Views bypass RLS of their base tables; health is admin-only via the API.
    EXECUTE 'REVOKE ALL ON source_health FROM authenticated';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION is_admin() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION is_admin() TO authenticated';
  END IF;
END $$;

-- ============================================================
-- Realtime: research progress streams to the browser
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'session_events'
     ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.session_events';
  END IF;
END $$;

-- ============================================================
-- Verification — should list 14 tables, all with RLS on
-- ============================================================

SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN ('app_admins', 'feature_flags', 'sources', 'catalog_products', 'catalog_variants', 'catalog_identifiers',
                    'listings', 'research_sessions', 'session_events', 'fetch_attempts', 'observations', 'price_ranges',
                    'identity_review', 'feed_imports')
ORDER BY c.relname;
