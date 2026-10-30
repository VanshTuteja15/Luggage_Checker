-- Read-only measurements of the engine index for the v4 pre-build review.
-- Run: docker exec -i lt-dev-db psql -U postgres -P pager=off -f - < scripts/bench/db-gaps.sql

\echo '== 1. Listings per store (active only): pages vs variant rows, identifiers'
select source_id,
       count(*) filter (where url not like '%?variant=%')                                        as pages,
       count(*) filter (where url like '%?variant=%')                                            as variant_rows,
       count(*) filter (where url not like '%?variant=%' and jsonb_array_length(identifiers) > 0) as pages_with_ids,
       count(*) filter (where identifiers::text like '%"gtin"%')                                 as rows_with_gtin,
       count(*) filter (where identifiers::text like '%"model"%')                                as rows_with_model,
       count(*) filter (where identifiers::text like '%"store_sku"%')                            as rows_with_sku,
       count(*) filter (where product_id is not null)                                            as linked_to_product
from listings where active group by source_id order by pages desc;

\echo '== 2. Pages (active) whose page or any of its variant rows carries a GTIN'
with pages as (
  select id, source_id, url from listings where active and url not like '%?variant=%'
), v as (
  select split_part(url, '?', 1) as page_url, bool_or(identifiers::text like '%"gtin"%') as has_gtin
  from listings where active and url like '%?variant=%' group by 1
)
select p.source_id, count(*) as pages, count(*) filter (where v.has_gtin) as pages_with_gtin_variant
from pages p left join v on v.page_url = p.url group by p.source_id order by pages desc;

\echo '== 3. Catalogue: products, variants, identifiers, attributes'
select (select count(*) from catalog_products where status = 'active')                        as products_active,
       (select count(*) from catalog_products where attributes <> '{}'::jsonb)                as products_with_attributes,
       (select count(*) from catalog_variants)                                                as variants,
       (select count(*) from catalog_variants where attributes <> '{}'::jsonb)                as variants_with_attributes,
       (select count(*) from catalog_products where size_class is null and status = 'active') as products_no_size;
select kind, count(*) from catalog_identifiers group by kind order by kind;

\echo '== 4. Size class and brand coverage of active page listings'
select source_id,
       count(*) as pages,
       count(*) filter (where size_class is not null) as with_size_class,
       count(*) filter (where brand is not null)      as with_brand,
       count(*) filter (where colour is not null)     as with_colour
from listings where active and url not like '%?variant=%' group by source_id order by pages desc;

\echo '== 5. Observations: volume, outcome, adapter'
select count(*) as observations, min(fetched_at) as first, max(fetched_at) as last from observations;
select outcome, count(*) from observations group by outcome order by 2 desc;
select adapter, count(*) from observations group by adapter order by 2 desc;

\echo '== 6. Promotions proxy: shown readings with a list (compare-at) price'
select count(*) filter (where outcome <> 'rejected')                            as shown,
       count(*) filter (where outcome <> 'rejected' and list_price is not null) as shown_with_list_price,
       count(distinct listing_id) filter (where outcome <> 'rejected' and list_price is not null) as listings_on_sale
from observations;

\echo '== 7. Observations and fetch attempts per day (last 30 days with data)'
select date_trunc('day', fetched_at)::date as day, count(*) as observations
from observations group by 1 order by 1 desc limit 30;
select date_trunc('day', started_at)::date as day, count(*) as attempts,
       count(*) filter (where outcome = 'ok') as ok
from fetch_attempts group by 1 order by 1 desc limit 30;

\echo '== 8. Database size and the largest tables'
select pg_size_pretty(pg_database_size(current_database())) as db_size,
       pg_database_size(current_database())                 as db_bytes;
select c.relname as table, pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_total_relation_size(c.oid) as bytes, c.reltuples::bigint as approx_rows
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc limit 15;

\echo '== 9. Average stored bytes per row (heap + toast + indexes)'
select round(pg_total_relation_size('observations')::numeric / greatest(1, (select count(*) from observations)), 1) as bytes_per_observation,
       round(pg_total_relation_size('price_ranges')::numeric / greatest(1, (select count(*) from price_ranges)), 1) as bytes_per_price_range,
       round(pg_total_relation_size('fetch_attempts')::numeric / greatest(1, (select count(*) from fetch_attempts)), 1) as bytes_per_fetch_attempt,
       round(pg_total_relation_size('listings')::numeric / greatest(1, (select count(*) from listings)), 1) as bytes_per_listing;

\echo '== 10. Review queue and sessions'
select status, count(*) from identity_review group by status;
select count(*) as sessions, count(*) filter (where status = 'done') as done from research_sessions;
