/* ------------------------------------------------------------------ */
/*  Database types — mirrors supabase/migrations/001_initial_schema   */
/*  Regenerate with: npx supabase gen types typescript > types.ts     */
/* ------------------------------------------------------------------ */

export type DbProduct = {
  id: string;
  slug: string;
  name: string;
  brand: string;
  model: string;
  color: string;
  upc: string | null;
  image_url: string | null;
  created_at: string;
  updated_at: string;
};

export type DbRetailerOffer = {
  id: string;
  product_id: string;
  retailer: string;
  price: number;
  currency: string;
  in_stock: boolean;
  url: string | null;
  last_checked_at: string;
};

export type DbPriceHistory = {
  id: string;
  product_id: string;
  retailer: string;
  price: number;
  currency: string;
  date: string;
  created_at: string;
};

export type DbTrackedProduct = {
  id: string;
  user_id: string;
  product_id: string;
  created_at: string;
};

export type DbUserSettings = {
  user_id: string;
  admin_email: string | null;
  timezone: string;
  refresh_interval: string;
  daily_report: boolean;
  report_email: string | null;
  include_drops: boolean;
  include_increases: boolean;
  include_oos: boolean;
  include_summary: boolean;
  serp_api_key: string | null;
  retailers: string[];
  updated_at: string;
};

/** Product with its current offers and price history attached. */
export type ProductWithData = DbProduct & {
  offers: DbRetailerOffer[];
  history: Record<string, { date: string; price: number }[]>;
  previousLowest: number;
};
