-- Migration 008: Chart history, usage totals and automatic clean-up
--
-- The dashboard used to download the last 600 raw rows (about 10 minutes of
-- data) and draw every chart from them. These functions summarise any period
-- on the server instead, so the 1h/6h/24h charts show the real period.

-- ---------------------------------------------------------------------------
-- get_reading_history: one row per time bucket for a chart range
--   15m -> 15 s buckets, 1h -> 1 min, 6h -> 5 min, 24h -> 20 min
-- ---------------------------------------------------------------------------
create or replace function public.get_reading_history(p_range text)
returns table (
  bucket_start timestamptz,
  avg_flow_rate_1 numeric,
  avg_flow_rate_2 numeric,
  avg_percentage_loss numeric,
  max_percentage_loss numeric,
  avg_water_level numeric,
  avg_humidity numeric,
  volume_1_liters numeric,
  volume_2_liters numeric,
  samples integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_span interval;
  v_bucket interval;
begin
  select s.span, s.bucket
    into v_span, v_bucket
    from (values
      ('15m', interval '15 minutes', interval '15 seconds'),
      ('1h',  interval '1 hour',     interval '1 minute'),
      ('6h',  interval '6 hours',    interval '5 minutes'),
      ('24h', interval '24 hours',   interval '20 minutes')
    ) as s (range_key, span, bucket)
   where s.range_key = p_range;

  if v_span is null then
    raise exception 'Unknown range "%". Use 15m, 1h, 6h or 24h.', p_range using errcode = '22023';
  end if;

  return query
    select date_bin(v_bucket, r.timestamp, timestamptz '2000-01-01 00:00:00+00'),
           round(avg(r.flow_rate_1), 2),
           round(avg(r.flow_rate_2), 2),
           round(avg(r.percentage_loss), 2),
           round(max(r.percentage_loss), 2),
           round(avg(r.water_level), 2),
           round(avg(r.humidity), 2),
           round(sum(r.volume_1_ml) / 1000.0, 3),
           round(sum(r.volume_2_ml) / 1000.0, 3),
           count(*)::integer
      from public.water_readings r
     where r.timestamp >= now() - v_span
       and r.timestamp <= now() + interval '1 minute'
     group by 1
     order by 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_usage_summary: water totals since a point in time (at most 31 days back)
-- The dashboard passes local midnight to get "today".
-- ---------------------------------------------------------------------------
create or replace function public.get_usage_summary(p_since timestamptz)
returns table (
  total_1_liters numeric,
  total_2_liters numeric,
  loss_liters numeric,
  samples integer,
  first_reading_at timestamptz,
  last_reading_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select round(coalesce(sum(r.volume_1_ml), 0) / 1000.0, 3),
         round(coalesce(sum(r.volume_2_ml), 0) / 1000.0, 3),
         round(greatest(coalesce(sum(r.volume_1_ml - r.volume_2_ml), 0), 0) / 1000.0, 3),
         count(*)::integer,
         min(r.timestamp),
         max(r.timestamp)
    from public.water_readings r
   where r.timestamp >= greatest(coalesce(p_since, now() - interval '1 day'), now() - interval '31 days')
     and r.timestamp <= now() + interval '1 minute';
$$;

revoke all on function public.get_reading_history from public;
revoke all on function public.get_usage_summary from public;
grant execute on function public.get_reading_history to anon, authenticated, service_role;
grant execute on function public.get_usage_summary to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Retention: keep 30 days of readings, 180 days of alerts, 30 days of commands.
-- Rows dated more than a day in the future can only come from the old
-- open-write setup (or the old time-zone bug), so they are removed too.
-- ---------------------------------------------------------------------------
create or replace function private.purge_old_data(
  p_reading_days integer default 30,
  p_alert_days integer default 180,
  p_command_days integer default 30
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_readings bigint;
  v_alerts bigint;
  v_commands bigint;
begin
  delete from public.water_readings
   where timestamp < now() - make_interval(days => greatest(p_reading_days, 1))
      or timestamp > now() + interval '1 day';
  get diagnostics v_readings = row_count;

  delete from public.alerts
   where timestamp < now() - make_interval(days => greatest(p_alert_days, 1))
      or timestamp > now() + interval '1 day';
  get diagnostics v_alerts = row_count;

  delete from public.valve_commands
   where requested_at < now() - make_interval(days => greatest(p_command_days, 1));
  get diagnostics v_commands = row_count;

  return jsonb_build_object('readings', v_readings, 'alerts', v_alerts, 'valve_commands', v_commands);
end;
$$;

revoke all on function private.purge_old_data from public, anon, authenticated;

-- Schedule the clean-up daily at 03:17 UTC when pg_cron is available
-- (it is on Supabase). Otherwise, run "select private.purge_old_data();" yourself.
do $outer$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    raise notice 'pg_cron could not be enabled (SQLSTATE %: %). Run "select private.purge_old_data();" daily yourself.',
      sqlstate, sqlerrm;
    return;
  end;

  perform cron.unschedule(jobid) from cron.job where jobname = 'flowstate-purge-old-data';
  perform cron.schedule('flowstate-purge-old-data', '17 3 * * *', 'select private.purge_old_data();');
end
$outer$;

notify pgrst, 'reload schema';
