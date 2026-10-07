# Source Probe: Setup and Run

The probe checks, **from our own machine**, what each acquisition protocol actually returns. It is read-only:

- It identifies itself honestly with this User-Agent: `LuggageTrackerProbe/0.1 (...; contact: <you>)`.
- It honours robots.txt and crawl delays, waiting at least 3 s between requests to the same store.
- It sends about 70 requests in total.
- It never touches stores whose terms forbid automated access (Amazon, Walmart, Costco, Best Buy, Canadian Tire, London Drugs). eBay is reached through its official API only.
- Stores whose terms restrict scraping are probed **only** through their store-published agent channel (UCP).

## 1. Publish our UCP agent profile (5 min, once)

Shopify's agent channel requires every request to carry the URL of our **agent profile**. It's a public JSON file saying who the agent is and what it does: catalog search and lookup only, with no cart, checkout or orders. The file is `ucp/agent-profile.json` in this project.

It has to be served with `Content-Type: application/json` and a public cache header. jsDelivr (serving files from GitHub) does both:

1. On GitHub (VanshTuteja15), create a **public** repo named `luggagetracker-ucp-profile`.
2. Upload `ucp/agent-profile.json` to it as `agent-profile.json` and commit.
3. Copy the commit's full SHA (repo → Commits → copy).
4. Your profile URL is:
   `https://cdn.jsdelivr.net/gh/VanshTuteja15/luggagetracker-ucp-profile@<SHA>/agent-profile.json`
5. Open that URL in a browser. You should see the JSON.

When we deploy, the profile moves to our own domain (`/.well-known/ucp-agent`).

## 2. Add to `.env.local`

```
UCP_AGENT_PROFILE_URL=https://cdn.jsdelivr.net/gh/VanshTuteja15/luggagetracker-ucp-profile@<SHA>/agent-profile.json
PROBE_CONTACT=<an email stores can reach us at>

# Optional: eBay Browse API (free). developer.ebay.com → Hi <name> → Application Keys → Production keyset
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
```

Without the profile URL, the UCP checks are skipped and everything else still runs. Without eBay keys, the eBay section is skipped.

## 3. Run

```
npm run probe:sources -- --selftest     # offline parser checks (no network)
npm run probe:sources                   # the real probe, about 3–5 minutes
```

Optional: `npm run probe:sources -- --only=samsonite-ca,unluggage` runs just those stores.

Results print to the terminal and are saved to `docs/probe-results.json`.

## Caveat: which network this measures

Run from your PC, the probe measures a **Canadian residential connection**. A future cloud worker has a data-centre IP, and stores' bot protection often treats those more strictly. The architecture will plan for that, and we'll re-run the probe from the worker host once it's chosen.
