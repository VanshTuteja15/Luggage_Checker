# Agent board (v4)

Per `planning/v3/AGENT_PROTOCOL.md` §2. Claude Code writes tasks; Cursor works them; the owner commits.

| Task | Title | Owner | Status | Branch | Locked files |
|---|---|---|---|---|---|
| T-401 | Product page: what each store states (promotions + specs) | cursor | ready | v4/ui-T401 | `src/components/product/OfferFacts.tsx` (new), `src/app/products/[productId]/page.tsx`, `tests/app/offer-facts.test.tsx` (new) |
| T-501 | Admin: review near matches in batches | cursor | ready | v4/ui-T501 | `src/components/admin/ReviewQueue.tsx` (new), `src/app/admin/page.tsx` (the Reviews tab only), `tests/app/review-queue.test.tsx` (new) |
| T-601 | Store status: stores found, not reviewed yet | cursor | ready | v4/ui-T601 | `src/components/admin/CandidateStores.tsx` (new), `src/app/admin/page.tsx` (end of the Stores tab only), `tests/app/candidate-stores.test.tsx` (new) |
