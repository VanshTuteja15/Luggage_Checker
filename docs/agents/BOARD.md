# Agent board (v4)

Per `planning/v3/AGENT_PROTOCOL.md` §2. Claude Code writes tasks; Cursor works them; the owner commits.

| Task | Title | Owner | Status | Branch | Locked files |
|---|---|---|---|---|---|
| T-401 | Product page: what each store states (promotions + specs) | cursor | ready | v4/ui-T401 | `src/components/product/OfferFacts.tsx` (new), `src/app/products/[productId]/page.tsx`, `tests/app/offer-facts.test.tsx` (new) |
| T-501 | Admin: review near matches in batches | cursor | ready | v4/ui-T501 | `src/components/admin/ReviewQueue.tsx` (new), `src/app/admin/page.tsx` (the Reviews tab only), `tests/app/review-queue.test.tsx` (new) |
| T-601 | Store status: stores found, not reviewed yet | cursor | ready | v4/ui-T601 | `src/components/admin/CandidateStores.tsx` (new), `src/app/admin/page.tsx` (end of the Stores tab only), `tests/app/candidate-stores.test.tsx` (new) |
| T-701 | Search bar: autocomplete from our own index | cursor | ready | v5/ui-T701 | `src/components/SearchBox.tsx`, `tests/app/search-box.test.tsx` (new) |
| T-702 | Search: the answer card on top | cursor | ready | v5/ui-T702 | `src/components/research/AnswerCard.tsx` (new), `src/components/research/ResearchResults.tsx` (the answer card only), `tests/app/answer-card.test.tsx` (new) |
| T-703 | Search: suggestion sections under the results | cursor | blocked (after T-702) | v5/ui-T703 | `src/components/research/Suggestions.tsx` (new), `src/components/research/ResearchResults.tsx` (the suggestions only), `tests/app/suggestions.test.tsx` (new) |
| T-704 | Search: filter chips from what the search understood | cursor | ready | v5/ui-T704 | `src/components/research/FilterChips.tsx` (new), `src/app/search/page.tsx` (chips + `?q=` only), `tests/app/filter-chips.test.tsx` (new) |
