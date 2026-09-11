-- ============================================================
-- LuggageTracker — complete database setup
--
-- Run this ONCE in the Supabase SQL Editor. It creates everything:
-- tables, indexes, row-level security, triggers.
--
-- This replaces running 001 and 002 separately. It is idempotent —
-- safe to run again at any time without losing data.
-- ============================================================

-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS products (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  brand        TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '',
  upc          TEXT,
  image_url    TEXT,
  product_type TEXT,
  source_url   TEXT,
  last_checked_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retailer_offers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  retailer        TEXT NOT NULL,
  price           DECIMAL(10, 2) NOT NULL,
  currency        TEXT DEFAULT 'CAD',
  in_stock        BOOLEAN DEFAULT true,
  url             TEXT,
  title           TEXT,
  last_checked_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (product_id, retailer)
);

CREATE TABLE IF NOT EXISTS price_history (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  retailer   TEXT NOT NULL,
  price      DECIMAL(10, 2) NOT NULL,
  currency   TEXT DEFAULT 'CAD',
  date       DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracked_products (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  product_id    UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  target_price  DECIMAL(10, 2),
  alert_enabled BOOLEAN DEFAULT true,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  admin_email       TEXT,
  timezone          TEXT DEFAULT 'America/Edmonton',
  daily_report      BOOLEAN DEFAULT true,
  report_email      TEXT,
  include_drops     BOOLEAN DEFAULT true,
  include_increases BOOLEAN DEFAULT true,
  include_oos       BOOLEAN DEFAULT true,
  include_summary   BOOLEAN DEFAULT true,
  retailers         TEXT[] DEFAULT ARRAY[
    'Amazon.ca', 'Costco.ca', 'Walmart.ca', 'Hudson''s Bay',
    'Canadian Tire', 'Bentley', 'Best Buy Canada', 'London Drugs',
    'Samsonite.ca', 'TUMI.ca', 'Away', 'Travelpro',
    'Monos', 'Briggs & Riley', 'RIMOWA', 'CALPAK', 'eBay.ca'
  ],
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- ── Columns added after an earlier install ───────────────────
-- (No-ops on a fresh database; they matter if you already ran 001.)
ALTER TABLE products         ADD COLUMN IF NOT EXISTS product_type    TEXT;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS source_url      TEXT;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE retailer_offers  ADD COLUMN IF NOT EXISTS title           TEXT;
ALTER TABLE tracked_products ADD COLUMN IF NOT EXISTS target_price    DECIMAL(10, 2);
ALTER TABLE tracked_products ADD COLUMN IF NOT EXISTS alert_enabled   BOOLEAN DEFAULT true;
ALTER TABLE tracked_products ADD COLUMN IF NOT EXISTS notes           TEXT;

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_slug         ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_brand        ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_upc          ON products(upc);
CREATE INDEX IF NOT EXISTS idx_offers_product        ON retailer_offers(product_id);
CREATE INDEX IF NOT EXISTS idx_offers_retailer       ON retailer_offers(retailer);
CREATE INDEX IF NOT EXISTS idx_history_product_date  ON price_history(product_id, date);
CREATE INDEX IF NOT EXISTS idx_history_date          ON price_history(date);
CREATE INDEX IF NOT EXISTS idx_tracked_user          ON tracked_products(user_id);
CREATE INDEX IF NOT EXISTS idx_tracked_user_product  ON tracked_products(user_id, product_id);

-- ── One price row per product + retailer + day ───────────────
-- The refresh logic upserts on this. Without it, every price write
-- becomes a read-then-write race.
DELETE FROM price_history a
USING price_history b
WHERE a.ctid < b.ctid
  AND a.product_id = b.product_id
  AND a.retailer   = b.retailer
  AND a.date       = b.date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'price_history_unique_day') THEN
    ALTER TABLE price_history
      ADD CONSTRAINT price_history_unique_day UNIQUE (product_id, retailer, date);
  END IF;
END $$;

-- ============================================================
-- Row Level Security
--
-- The API acts AS the signed-in user, so these policies are what
-- actually protects the data — not application code.
-- ============================================================

ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailer_offers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings    ENABLE ROW LEVEL SECURITY;

-- Products, offers and history are shared reference data: any signed-in
-- user may read them, and may add or refresh them (that is what tracking
-- a new product does). They are not owned by anyone.
DROP POLICY IF EXISTS "Authenticated read products"   ON products;
CREATE POLICY "Authenticated read products"
  ON products FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated insert products" ON products;
CREATE POLICY "Authenticated insert products"
  ON products FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated update products" ON products;
CREATE POLICY "Authenticated update products"
  ON products FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read offers"     ON retailer_offers;
CREATE POLICY "Authenticated read offers"
  ON retailer_offers FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated manage offers"   ON retailer_offers;
CREATE POLICY "Authenticated manage offers"
  ON retailer_offers FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated read history"    ON price_history;
CREATE POLICY "Authenticated read history"
  ON price_history FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated insert history"  ON price_history;
CREATE POLICY "Authenticated insert history"
  ON price_history FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated update history"  ON price_history;
CREATE POLICY "Authenticated update history"
  ON price_history FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Tracked products and settings are strictly per-user.
DROP POLICY IF EXISTS "Own tracked products" ON tracked_products;
CREATE POLICY "Own tracked products"
  ON tracked_products FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Own settings" ON user_settings;
CREATE POLICY "Own settings"
  ON user_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Triggers
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS user_settings_updated_at ON user_settings;
CREATE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Give every new user a settings row automatically ─────────
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

-- Backfill for anyone who signed up before this ran.
INSERT INTO user_settings (user_id, admin_email, report_email)
SELECT id, email, email FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- Verification — should return 5 rows
-- ============================================================

SELECT
  table_name,
  (SELECT count(*) FROM information_schema.columns c
    WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name IN ('products', 'retailer_offers', 'price_history', 'tracked_products', 'user_settings')
ORDER BY table_name;
