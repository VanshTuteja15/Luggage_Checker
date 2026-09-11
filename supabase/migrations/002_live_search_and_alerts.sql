-- ============================================================
-- LuggageTracker — migration 002
-- Live search, price alerts, and tighter row-level security.
--
-- Run this in the Supabase SQL Editor after 001_initial_schema.sql.
-- Safe to re-run: every statement is guarded.
-- ============================================================

-- ── Products: richer metadata from live search ───────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS source_url   TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;

-- ── Offers: keep the retailer's own listing title ────────────
ALTER TABLE retailer_offers ADD COLUMN IF NOT EXISTS title TEXT;

-- ── Tracked products: per-user price alerts ──────────────────
ALTER TABLE tracked_products ADD COLUMN IF NOT EXISTS target_price  DECIMAL(10, 2);
ALTER TABLE tracked_products ADD COLUMN IF NOT EXISTS alert_enabled BOOLEAN DEFAULT true;
ALTER TABLE tracked_products ADD COLUMN IF NOT EXISTS notes         TEXT;

-- ── Price history: one row per product+retailer+day ──────────
-- The cron job upserts into this table. Without a unique constraint it
-- had to SELECT-then-UPDATE-or-INSERT on every write, which races.
-- De-duplicate any existing rows before adding the constraint.
DELETE FROM price_history a
USING price_history b
WHERE a.ctid < b.ctid
  AND a.product_id = b.product_id
  AND a.retailer   = b.retailer
  AND a.date       = b.date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'price_history_unique_day'
  ) THEN
    ALTER TABLE price_history
      ADD CONSTRAINT price_history_unique_day
      UNIQUE (product_id, retailer, date);
  END IF;
END $$;

-- ============================================================
-- Row Level Security
--
-- 001 enabled RLS but the API routes all ran with the service-role key,
-- so none of it was ever exercised. The API now acts as the signed-in
-- user, which means these policies are what actually protects the data.
-- ============================================================

-- Products and offers are shared reference data: any signed-in user may
-- read them, and may add/refresh them (that's what tracking a new product
-- does). They are not user-owned, so no per-row ownership check applies.
DROP POLICY IF EXISTS "Authenticated update products" ON products;
CREATE POLICY "Authenticated update products"
  ON products FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated update history" ON price_history;
CREATE POLICY "Authenticated update history"
  ON price_history FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- Tracked products and settings stay strictly per-user. These already
-- existed in 001; re-declared here so this migration is self-contained
-- and the ownership rule is visible in one place.
DROP POLICY IF EXISTS "Own tracked products" ON tracked_products;
CREATE POLICY "Own tracked products"
  ON tracked_products FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Own settings" ON user_settings;
CREATE POLICY "Own settings"
  ON user_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── Helpful indexes for the dashboard queries ────────────────
CREATE INDEX IF NOT EXISTS idx_offers_retailer      ON retailer_offers(retailer);
CREATE INDEX IF NOT EXISTS idx_history_date         ON price_history(date);
CREATE INDEX IF NOT EXISTS idx_tracked_user_product ON tracked_products(user_id, product_id);

-- ── Auto-create settings for each new user ───────────────────
-- Avoids every settings read having to handle "row doesn't exist yet".
CREATE OR REPLACE FUNCTION create_default_user_settings()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_settings (user_id, admin_email, report_email)
  VALUES (NEW.id, NEW.email, NEW.email)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_settings ON auth.users;
CREATE TRIGGER on_auth_user_created_settings
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION create_default_user_settings();

-- Backfill settings rows for users who signed up before this migration.
INSERT INTO user_settings (user_id, admin_email, report_email)
SELECT id, email, email FROM auth.users
ON CONFLICT (user_id) DO NOTHING;
