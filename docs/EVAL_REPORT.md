# Eval report

Run 2026-11-23T15:35:27.435Z at commit `73a1689` (rules only). Sets: `scripts/bench/sets/` (real data, labelled by hand). Command: `npm run eval`.

| Task | Items | All fields right | Per field | Notes |
|---|---|---|---|---|
| queries | 68 | 100% | brand 100% (68/68), line 100% (66/66), sizeClass 100% (68/68), inches 100% (68/68), type 100% (68/68), colour 100% (68/68), maxPrice 100% (68/68), model 100% (68/68) | vocabulary snapshot of 2026-11-23 (50 brands, 1558 lines); type scored from v5 |
| titles | 100 | 53% | brand 80% (80/100), line 61.6% (53/86), sizeClass 87% (87/100), inches 100% (100/100) | version isn't a parser field yet, so it isn't scored |
| attributes | 40 | 95% | dimsCm 100% (40/40), capacityL 100% (40/40), weightKg 100% (40/40), wheels 95% (38/40), expandable 100% (40/40) |  |
| pairs | 80 | 61.3% | verdict 61.3% (49/80), sameRecall 10.3% (3/29) | a near match goes to the review queue (counted as not right, never merged); the AI judge, when measured, only advises on those; {"wrongMerges":0,"sentToReview":7} |
| terms | 16 | 100% | category 100% (16/16), quoteVerbatim 100% (11/11) |  |
| promos | 30 | 96.7% | isPromotion 100% (30/30), kinds 100% (30/30), numbers 96.7% (29/30) | {"predictedPromotions":14,"fakePromotions":0,"precision":100} |

Compared with the previous run (2026-11-23T15:14:45.885Z, `73a1689`): no metric dropped by more than 1 point.

## Accepted drops

One line per accepted drop: `- \`task.metric\`: reason` (kept from the previous report).
