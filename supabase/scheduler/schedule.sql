-- ============================================================
-- LuggageTracker: on-time scheduler (R1.16). NOT a migration.
--
-- Supabase pg_cron calls the app's POST /api/cron/tick every 15
-- minutes (UTC). The app decides what is due for the 9:00 a.m.
-- Calgary email (DST-correct) and does it once; extra calls are safe.
--
-- The app's address and CRON_SECRET are read from Supabase Vault at
-- run time, never written in this file. Before running it, store them
-- once (SQL Editor; replace the two placeholders):
--
--   select vault.create_secret('https://<your-app-address>', 'luggagetracker_app_url');
--   select vault.create_secret('<the same CRON_SECRET as the app>', 'luggagetracker_cron_secret');
--
-- To change one later: select vault.update_secret(
--   (select id from vault.secrets where name = 'luggagetracker_app_url'), 'https://new-address');
--
-- Run this whole file in the Supabase SQL Editor. Safe to run again.
-- Stop it with supabase/scheduler/unschedule.sql.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace an earlier version of the job, if any.
select cron.unschedule(jobid) from cron.job where jobname = 'luggagetracker-tick';

select cron.schedule(
  'luggagetracker-tick',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'luggagetracker_app_url')
             || '/api/cron/tick',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'luggagetracker_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 290000
    );
  $job$
);

-- Check: the job is there, and (after the next quarter hour) its calls.
select jobid, jobname, schedule, active from cron.job where jobname = 'luggagetracker-tick';
-- select status_code, created from net._http_response order by created desc limit 5;
