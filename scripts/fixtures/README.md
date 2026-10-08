# Fixtures

Inputs for the offline tests. Where each one came from matters, so it's recorded here.

## Recorded from the real stores (`npm run fixtures:record`)

Fetched on 7 Oct 2026 through the engine's own `PoliteFetcher` (honest `LuggageTrackerBot/1.0` User-Agent with a contact, robots.txt read first, crawl delays honoured), from channels the registry permits today only. `manifest.json` lists URL, HTTP status, outcome and time for each file.

| Folder | What | Stores |
|---|---|---|
| `shopify/` | `/products/<handle>.json` and `.js` bodies, byte for byte; plus a real 404 for a handle that doesn't exist | Canada Luggage Depot (sanctioned by its agents.md), Delsey.ca (terms silent) |
| `html/` | Product pages **reduced** to `<title>`, the `<head>` meta tags and every `application/ld+json` block (the parts the extractor reads); everything else dropped to keep the repo small | same two stores |
| `ucp/` | `/.well-known/ucp` discovery documents | same two stores |
| `blocks/` | Block pages from the P0 probe: Samsonite.ca's PerimeterX CAPTCHA (HTTP 307) and Sporting Life's Cloudflare challenge (HTTP 403) | Samsonite.ca, Sporting Life |
| `tavily-*.json` | Older Tavily research responses used by `npm run verify:search` | — |

## Not recordable yet: doc-shaped data inside the tests

These channels need something only a human can provide, so their responses can't be recorded yet. The tests build them inline, shaped exactly like the providers' published responses, and populated with **real values** (prices, barcodes, SKUs) from the recordings above or from `docs/probe-results.json`:

| Channel | Blocked on | Source of shape |
|---|---|---|
| Shopify UCP Catalog MCP (`search_catalog`, `get_product`) | publishing our agent profile | UCP 2026-08-25 catalog spec (minor-unit money, `barcodes[]`, `availability`) |
| eBay Browse API | free developer keys | eBay Browse API `item_summary/search` and `getItem` reference |
| Amazon (PA-API 5 contract) | an eligible Associates account | PA-API 5 `GetItems` reference |
| U.N. Luggage, Bentley product JSON | a human reading their terms | values copied from the 7 Oct probe (`docs/probe-results.json`) |

**Re-record once each item in `docs/HUMAN_ACTIONS.md` is done** and replace the inline shapes with recordings.
