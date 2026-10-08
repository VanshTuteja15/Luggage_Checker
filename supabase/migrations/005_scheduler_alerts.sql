-- ============================================================
-- LuggageTracker — migration 005
-- Scheduler support: price-alert de-duplication and a log of
-- scheduled engine runs (budgets, outcomes) for /admin.
--
-- Additive and idempotent. Run after 004. Existing tables are only
-- referenced, never altered.
-- ============================================================

-- One alert email per user, product and day, whatever re-runs happen.
CREATE TABLE IF NOT EXISTS price_alerts_sent (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  retailer     TEXT NOT NULL,
  price        NUMERIC(10, 2) NOT NULL CHECK (price > 0),
  target_price NUMERIC(10, 2) NOT NULL CHECK (target_price > 0),
  sent_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id, sent_on)
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON price_alerts_sent(user_id, sent_on DESC);

-- Scheduled engine runs: what ran, when, and what it spent.
CREATE TABLE IF NOT EXISTS engine_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job         TEXT NOT NULL CHECK (job ~ '^[a-z.]{3,40}$'),
  trigger     TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'admin', 'worker', 'manual')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,
  stats       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_engine_runs_started ON engine_runs(started_at DESC);

ALTER TABLE price_alerts_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_runs       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Own price alerts" ON price_alerts_sent;
CREATE POLICY "Own price alerts" ON price_alerts_sent FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins read engine runs" ON engine_runs;
CREATE POLICY "Admins read engine runs" ON engine_runs FOR SELECT TO authenticated USING (is_admin());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON price_alerts_sent, engine_runs FROM anon';
  END IF;
END $$;

-- Verification — should list both tables with RLS on
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('price_alerts_sent', 'engine_runs')
ORDER BY c.relname;
