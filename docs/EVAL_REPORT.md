# Eval report

Run 2026-10-30T10:09:46.697Z at commit `fd13f4d` (rules only). Sets: `scripts/bench/sets/` (real data, labelled by hand). Command: `npm run eval`.

| Task | Items | All fields right | Per field | Notes |
|---|---|---|---|---|
| queries | 60 | 60% | brand 96.7% (58/60), line 69% (40/58), sizeClass 93.3% (56/60), inches 90% (54/60), colour 98.3% (59/60), maxPrice 98.3% (59/60), model 100% (60/60) | type (spinner/duffel/…) isn't produced by the parser yet, so it isn't scored |
| titles | 100 | 53% | brand 80% (80/100), line 61.6% (53/86), sizeClass 87% (87/100), inches 100% (100/100) | version isn't a parser field yet, so it isn't scored |
| attributes | 40 | 95% | dimsCm 100% (40/40), capacityL 100% (40/40), weightKg 100% (40/40), wheels 95% (38/40), expandable 100% (40/40) |  |
| pairs | 80 | 61.3% | verdict 61.3% (49/80), sameRecall 10.3% (3/29) | a near match goes to the review queue (counted as not right, never merged); the AI judge, when measured, only advises on those; {"wrongMerges":0,"sentToReview":8} |
| terms | 16 | 100% | category 100% (16/16), quoteVerbatim 100% (11/11) |  |
| promos | 30 | 96.7% | isPromotion 100% (30/30), kinds 100% (30/30), numbers 96.7% (29/30) | {"predictedPromotions":14,"fakePromotions":0,"precision":100} |

Compared with the previous run (2026-10-30T09:56:19.393Z, `fd13f4d`): no metric dropped by more than 1 point.

## Accepted drops

One line per accepted drop: `- \`task.metric\`: reason` (kept from the previous report).
