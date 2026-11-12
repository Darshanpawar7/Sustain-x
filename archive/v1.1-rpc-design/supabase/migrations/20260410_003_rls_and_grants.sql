-- Migration 003: RLS policies and grants for anon/authenticated clients

alter table public.water_readings enable row level security;
alter table public.alerts enable row level security;

-- Grant table privileges used by ESP32 and web dashboard
-- (Supabase keys map to database roles such as anon/authenticated).
grant usage on schema public to anon, authenticated;
grant select, insert on public.water_readings to anon, authenticated;
grant select, insert on public.alerts to anon, authenticated;
grant usage, select on sequence public.water_readings_id_seq to anon, authenticated;
grant usage, select on sequence public.alerts_id_seq to anon, authenticated;

-- Read policies for dashboard queries/realtime
drop policy if exists "water_readings_select_anon" on public.water_readings;
create policy "water_readings_select_anon"
  on public.water_readings
  for select
  to anon
  using (true);

drop policy if exists "water_readings_select_authenticated" on public.water_readings;
create policy "water_readings_select_authenticated"
  on public.water_readings
  for select
  to authenticated
  using (true);

drop policy if exists "alerts_select_anon" on public.alerts;
create policy "alerts_select_anon"
  on public.alerts
  for select
  to anon
  using (true);

drop policy if exists "alerts_select_authenticated" on public.alerts;
create policy "alerts_select_authenticated"
  on public.alerts
  for select
  to authenticated
  using (true);

-- Insert policies for ESP32 POST requests
drop policy if exists "water_readings_insert_anon" on public.water_readings;
create policy "water_readings_insert_anon"
  on public.water_readings
  for insert
  to anon
  with check (true);

drop policy if exists "water_readings_insert_authenticated" on public.water_readings;
create policy "water_readings_insert_authenticated"
  on public.water_readings
  for insert
  to authenticated
  with check (true);

drop policy if exists "alerts_insert_anon" on public.alerts;
create policy "alerts_insert_anon"
  on public.alerts
  for insert
  to anon
  with check (true);

drop policy if exists "alerts_insert_authenticated" on public.alerts;
create policy "alerts_insert_authenticated"
  on public.alerts
  for insert
  to authenticated
  with check (true);
