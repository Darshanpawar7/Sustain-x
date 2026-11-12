-- Migration 002: Add indexes and enable Realtime streaming

create index if not exists idx_water_readings_timestamp_desc
  on public.water_readings (timestamp desc);

create index if not exists idx_alerts_timestamp_desc
  on public.alerts (timestamp desc);

-- Include both tables in Supabase Realtime publication
-- Using conditional blocks keeps this migration idempotent.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'water_readings'
  ) then
    execute 'alter publication supabase_realtime add table public.water_readings';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'alerts'
  ) then
    execute 'alter publication supabase_realtime add table public.alerts';
  end if;
end $$;
