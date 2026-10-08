/* ------------------------------------------------------------------ */
/*  The adapter set. One module per protocol; the registry decides     */
/*  which ones a store may use (src/lib/engine/registry).              */
/* ------------------------------------------------------------------ */

import type { AdapterId } from "../types";
import { amazonCreators } from "./amazon-creators";
import type { Adapter } from "./base";
import { ebayBrowse } from "./ebay-browse";
import { feedImport } from "./feed-import";
import { htmlStructured } from "./html-structured";
import { manualEntry } from "./manual-entry";
import { shopifyProductJson } from "./shopify-product-json";
import { shopifyUcp } from "./shopify-ucp";

export const ADAPTERS: Record<AdapterId, Adapter> = {
  shopify_ucp: shopifyUcp,
  shopify_product_json: shopifyProductJson,
  html_structured: htmlStructured,
  ebay_browse_api: ebayBrowse,
  amazon_creators_api: amazonCreators,
  feed_import: feedImport,
  manual_entry: manualEntry,
};

export type { Adapter, AdapterContext, AdapterResult, AdapterStatus, ListingRef } from "./base";
