-- ============================================================
-- LuggageTracker — initial database schema
-- Run this in the Supabase SQL Editor after creating your project.
-- ============================================================

-- Products ────────────────────────────────────────────────────
CREATE TABLE products (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  brand      TEXT NOT NULL,
  model      TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '',
  upc        TEXT,
  image_url  TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_products_slug  ON products(slug);
CREATE INDEX idx_products_brand ON products(brand);
CREATE INDEX idx_products_upc   ON products(upc);

-- Current retailer offers (latest snapshot per retailer) ──────
CREATE TABLE retailer_offers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id      UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  retailer        TEXT NOT NULL,
  price           DECIMAL(10, 2) NOT NULL,
  currency        TEXT DEFAULT 'CAD',
  in_stock        BOOLEAN DEFAULT true,
  url             TEXT,
  last_checked_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, retailer)
);

CREATE INDEX idx_offers_product ON retailer_offers(product_id);

-- Historical price data ───────────────────────────────────────
CREATE TABLE price_history (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  retailer   TEXT NOT NULL,
  price      DECIMAL(10, 2) NOT NULL,
  currency   TEXT DEFAULT 'CAD',
  date       DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_history_product_date     ON price_history(product_id, date);
CREATE INDEX idx_history_product_retailer ON price_history(product_id, retailer, date);

-- Tracked products (per user) ─────────────────────────────────
CREATE TABLE tracked_products (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, product_id)
);

CREATE INDEX idx_tracked_user ON tracked_products(user_id);

-- User settings ───────────────────────────────────────────────
CREATE TABLE user_settings (
  user_id           UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  admin_email       TEXT,
  timezone          TEXT DEFAULT 'America/Edmonton',
  refresh_interval  TEXT DEFAULT '24h',
  daily_report      BOOLEAN DEFAULT true,
  report_email      TEXT,
  include_drops     BOOLEAN DEFAULT true,
  include_increases BOOLEAN DEFAULT true,
  include_oos       BOOLEAN DEFAULT true,
  include_summary   BOOLEAN DEFAULT true,
  serp_api_key      TEXT,
  retailers         TEXT[] DEFAULT ARRAY[
    'Amazon.ca', 'Costco.ca', 'Walmart.ca', 'Hudson''s Bay',
    'Canadian Tire', 'Bentley', 'Best Buy Canada', 'London Drugs',
    'Samsonite.ca', 'TUMI.ca', 'Away', 'Travelpro',
    'Monos', 'Briggs & Riley', 'eBay.ca'
  ],
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailer_offers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings    ENABLE ROW LEVEL SECURITY;

-- Products & offers & history: readable by any authenticated user,
-- writable by service role (cron jobs bypass RLS).
CREATE POLICY "Authenticated read products"
  ON products FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated insert products"
  ON products FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated read offers"
  ON retailer_offers FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated manage offers"
  ON retailer_offers FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read history"
  ON price_history FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated insert history"
  ON price_history FOR INSERT TO authenticated WITH CHECK (true);

-- Tracked products: users see & manage only their own.
CREATE POLICY "Own tracked products"
  ON tracked_products FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Settings: users see & manage only their own.
CREATE POLICY "Own settings"
  ON user_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Helper: auto-update updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
