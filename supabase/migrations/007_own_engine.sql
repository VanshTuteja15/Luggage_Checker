-- ============================================================
-- 007: own engine (v4). Additive and idempotent, like 004–006.
--
-- A1  ai_cache: evidence-checked answers of the local AI tasks,
--     keyed by sha256(task, model, prompt version, schema version,
--     input). Never prices. Written by the server/worker connection;
--     admins may read it; anon never.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_cache (
  key        TEXT PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  task       TEXT NOT NULL CHECK (task IN ('attributes', 'match_judge', 'terms')),
  model      TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
  value      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_expires ON ai_cache(expires_at);

ALTER TABLE ai_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read ai cache" ON ai_cache;
CREATE POLICY "Admins read ai cache" ON ai_cache FOR SELECT TO authenticated USING (is_admin());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ai_cache FROM anon';
  END IF;
END $$;

-- Expired answers are ignored on read; this removes them (daily engine jobs).
CREATE OR REPLACE FUNCTION ai_cache_prune()
RETURNS INTEGER AS $$
DECLARE
  n INTEGER;
BEGIN
  DELETE FROM ai_cache WHERE expires_at <= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION ai_cache_prune() FROM PUBLIC;

-- ============================================================
-- A3  Bulk catalogue reads (Shopify /products.json) index listings
--     as 'catalog'.
-- ============================================================

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_discovered_via_check;
ALTER TABLE listings ADD CONSTRAINT listings_discovered_via_check
  CHECK (discovered_via IN ('sitemap', 'ucp', 'feed', 'tavily', 'manual', 'live_search', 'seed', 'catalog'));

-- ============================================================
-- A4  Promotions the store itself states: a Shopify compare-at or
--     JSON-LD list/strikethrough price above the price, or offer text
--     ("20% off", "free shipping over $100"). One row per distinct
--     promotion per listing; a repeat extends last_seen_at. A row is
--     current while its listing's latest shown reading still shows it
--     and its own end date (ends_text verbatim, ends_at approximate)
--     hasn't passed. Never a price source: prices stay in observations.
-- ============================================================

CREATE TABLE IF NOT EXISTS promotions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id     UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('percent_off', 'amount_off', 'sale_price', 'free_shipping', 'gift', 'code')),
  method         TEXT NOT NULL CHECK (method IN ('compare_at', 'jsonld', 'page_text')),
  percent_off    NUMERIC(5, 2) CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off < 100)),
  up_to          BOOLEAN NOT NULL DEFAULT false,
  amount_off     NUMERIC(10, 2) CHECK (amount_off IS NULL OR amount_off > 0),
  sale_price     NUMERIC(10, 2) CHECK (sale_price IS NULL OR sale_price > 0),
  was_price      NUMERIC(10, 2) CHECK (was_price IS NULL OR was_price > 0),
  threshold      NUMERIC(10, 2) CHECK (threshold IS NULL OR threshold >= 0),
  code           TEXT CHECK (code IS NULL OR char_length(code) BETWEEN 3 AND 20),
  ends_text      TEXT CHECK (ends_text IS NULL OR char_length(ends_text) <= 200),
  ends_at        TIMESTAMPTZ,
  evidence       JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  fingerprint    TEXT NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 400),
  first_seen_at  TIMESTAMPTZ NOT NULL,
  last_seen_at   TIMESTAMPTZ NOT NULL,
  -- The reading that last showed it (no FK: retention may remove old observations).
  observation_id BIGINT,
  CHECK (last_seen_at >= first_seen_at),
  -- A stated sale is below the store's own was-price, never equal to it.
  CHECK (sale_price IS NULL OR was_price IS NULL OR sale_price < was_price),
  UNIQUE (listing_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_promotions_listing ON promotions(listing_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_promotions_source ON promotions(source_id, last_seen_at DESC);

ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

-- Like prices: public reference data for signed-in users; only the engine writes.
DROP POLICY IF EXISTS "Authenticated read promotions" ON promotions;
CREATE POLICY "Authenticated read promotions" ON promotions FOR SELECT TO authenticated USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON promotions FROM anon';
  END IF;
END $$;
