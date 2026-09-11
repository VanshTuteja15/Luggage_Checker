-- ============================================================
-- LuggageTracker — migration 003
-- Search result caching and provider quota tracking.
--
-- Every price provider has a small free allowance. These two tables
-- make that allowance last: the cache means a repeated search costs
-- nothing, and the usage counter stops us blowing the quota.
--
-- Idempotent — safe to run again.
-- ============================================================

-- ── Cached search responses ──────────────────────────────────
CREATE TABLE IF NOT EXISTS search_cache (
  cache_key   TEXT PRIMARY KEY,
  query       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  response    JSONB NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);

-- ── Provider call counter ────────────────────────────────────
-- `period` is 'YYYY-MM' for allowances that reset monthly (SerpAPI),
-- or 'total' for one-time allowances that never refill (Serper).
CREATE TABLE IF NOT EXISTS provider_usage (
  provider   TEXT NOT NULL,
  period     TEXT NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, period)
);

-- ============================================================
-- Atomic increment
--
-- Two concurrent searches must not both read 249 and write 250.
-- A single INSERT .. ON CONFLICT DO UPDATE is atomic, and returning
-- the new value lets the caller enforce the cap without a re-read.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_provider_usage(
  p_provider TEXT,
  p_period   TEXT,
  p_amount   INTEGER DEFAULT 1
)
RETURNS INTEGER AS $$
DECLARE
  new_total INTEGER;
BEGIN
  INSERT INTO provider_usage (provider, period, calls, updated_at)
  VALUES (p_provider, p_period, p_amount, now())
  ON CONFLICT (provider, period) DO UPDATE
    SET calls = provider_usage.calls + p_amount,
        updated_at = now()
  RETURNING calls INTO new_total;

  RETURN new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Cache housekeeping ───────────────────────────────────────
CREATE OR REPLACE FUNCTION purge_expired_search_cache()
RETURNS INTEGER AS $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM search_cache WHERE expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Row Level Security
--
-- Both tables are shared operational infrastructure, not user data:
-- the cache holds public retail listings and the counter holds call
-- totals. Any signed-in user may read and update them. Neither ever
-- holds anything personal.
-- ============================================================

ALTER TABLE search_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated use search cache" ON search_cache;
CREATE POLICY "Authenticated use search cache"
  ON search_cache FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read usage" ON provider_usage;
CREATE POLICY "Authenticated read usage"
  ON provider_usage FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated write usage" ON provider_usage;
CREATE POLICY "Authenticated write usage"
  ON provider_usage FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

GRANT EXECUTE ON FUNCTION increment_provider_usage(TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION purge_expired_search_cache() TO authenticated;

-- ============================================================
-- Verification — should return 2 tables and 2 functions
-- ============================================================

SELECT 'table' AS kind, table_name AS name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('search_cache', 'provider_usage')
UNION ALL
SELECT 'function', routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('increment_provider_usage', 'purge_expired_search_cache')
ORDER BY kind, name;
