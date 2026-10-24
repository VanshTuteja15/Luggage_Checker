-- Stop LuggageTracker's scheduler (see schedule.sql). Safe to run again.
-- The Vault secrets stay; delete them separately if you no longer need them.
select cron.unschedule(jobid) from cron.job where jobname = 'luggagetracker-tick';
