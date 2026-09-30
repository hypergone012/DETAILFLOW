-- Schedules notify-dispatcher every minute with pg_cron + pg_net.
-- Run ONCE per project in the SQL editor (as postgres), after replacing the
-- two placeholders. Secrets live in Supabase Vault, not in the cron command.
--   <PROJECT_URL>          https://<ref>.supabase.co
--   <DISPATCHER_SECRET>    same value as DF_DISPATCHER_SECRET

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<PROJECT_URL>', 'df_project_url', 'DETAILFLOW project URL');
select vault.create_secret('<DISPATCHER_SECRET>', 'df_dispatcher_secret', 'notify-dispatcher shared secret');

select cron.schedule(
  'df-notify-dispatcher',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'df_project_url') || '/functions/v1/notify-dispatcher',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-dispatcher-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'df_dispatcher_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);

-- Check: select * from cron.job; select * from cron.job_run_details order by start_time desc limit 5;
