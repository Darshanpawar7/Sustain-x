-- =============================================================================
-- FlowState (Team 10): database setup for the final ESP32 sketch
-- =============================================================================
-- Run this once in the Supabase SQL Editor of a NEW project. It is safe to run
-- again: nothing is dropped and no data is deleted.
--
-- It matches the ESP32 firmware (ESP32_Code/FlowState_ESP32, and the earlier
-- single-file FlowState_ESP32_Final.ino), which posts straight into two tables
-- over HTTPS with the project's public (anon) key:
--   water_readings  every 10 seconds
--   alerts          when something happens (leak, night flow, valve, anomaly)
-- (The live 2-second MQTT messages go through the MQTT broker, not this database.)
--
-- Do NOT also run supabase/migrations/20260929_005 to _008 on this project:
-- they block direct inserts, and the final sketch would stop uploading.
--
-- What the public key may do:
--   * read both tables (the dashboard), and get live updates (Realtime)
--   * add rows to both tables (the ESP32)
--   * never change or delete rows
-- What protects the data:
--   * every value is range-checked, so impossible readings are refused
--   * a reading dated more than 5 minutes away from the server clock is
--     stored at the time it arrived (the device time is kept as well)
--   * at most 60 readings and 30 alerts a minute are accepted (the sketch
--     sends 6 readings a minute)
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.water_readings (
  id                 bigint generated always as identity primary key,
  "timestamp"        timestamptz   not null default now(),
  flow_rate_1        numeric(10,2) not null default 0,  -- L/min, tank outlet (sensor 1)
  flow_rate_2        numeric(10,2) not null default 0,  -- L/min, tap (sensor 2)
  percentage_loss    numeric(6,2)  not null default 0,  -- % lost between the sensors, last 60 s
  water_level        numeric(10,2) not null default 0,  -- cm of water in the tank
  valve_state        smallint      not null default 0,  -- 1 = open, 0 = closed
  leak_status        text          not null default 'Normal',
  anomaly_status     text          not null default 'Learning',
  system_online      smallint      not null default 1,
  daily_total_liters numeric(12,3) not null default 0,  -- litres through sensor 1 since midnight
  humidity           numeric(5,2),                      -- % RH, only if the sketch sends it
  temperature        numeric(5,2),                      -- deg C, only if the sketch sends it
  device_timestamp   timestamptz,                       -- the time the device sent
  received_at        timestamptz   not null default now(),
  constraint water_readings_flow_1_range   check (flow_rate_1 between 0 and 100),
  constraint water_readings_flow_2_range   check (flow_rate_2 between 0 and 100),
  constraint water_readings_loss_range     check (percentage_loss between 0 and 100),
  constraint water_readings_level_range    check (water_level between 0 and 1000),
  constraint water_readings_valve_values   check (valve_state in (0, 1)),
  constraint water_readings_leak_values    check (leak_status in ('Normal', 'Warning', 'Critical')),
  constraint water_readings_anomaly_text   check (char_length(anomaly_status) between 1 and 40),
  constraint water_readings_online_values  check (system_online in (0, 1)),
  constraint water_readings_total_range    check (daily_total_liters between 0 and 100000),
  constraint water_readings_humidity_range check (humidity is null or humidity between 0 and 100),
  constraint water_readings_temp_range     check (temperature is null or temperature between -40 and 85)
);

create table if not exists public.alerts (
  id               bigint generated always as identity primary key,
  "timestamp"      timestamptz not null default now(),
  alert_type       text        not null,
  message          text        not null default '',
  severity         text        not null default 'medium',
  device_timestamp timestamptz,
  received_at      timestamptz not null default now(),
  constraint alerts_type_format     check (alert_type ~ '^[A-Z0-9_]{1,60}$'),
  constraint alerts_message_length  check (char_length(message) <= 500),
  constraint alerts_severity_values check (severity in ('low', 'medium', 'high', 'critical'))
);

-- Connectivity health sent by firmware v2 (all optional, so older firmware still works).
alter table public.water_readings
  add column if not exists wifi_rssi      smallint check (wifi_rssi between -127 and 0),        -- Wi-Fi signal, dBm
  add column if not exists uptime_s       integer  check (uptime_s >= 0),                       -- seconds since boot
  add column if not exists free_heap      integer  check (free_heap >= 0),                      -- free memory, bytes
  add column if not exists upload_ms      integer  check (upload_ms between 0 and 600000),     -- last HTTPS upload time
  add column if not exists http_failures  integer  check (http_failures >= 0),                  -- failed uploads since boot
  add column if not exists mqtt_connected smallint check (mqtt_connected in (0, 1));            -- MQTT link up?

comment on table public.water_readings is 'One row every 10 s from the FlowState ESP32 (Team 10).';
comment on table public.alerts is 'Events raised by the FlowState ESP32: leaks, night flow, anomalies, valve changes.';

create index if not exists water_readings_timestamp_idx on public.water_readings ("timestamp" desc);
create index if not exists alerts_timestamp_idx on public.alerts ("timestamp" desc);

-- -----------------------------------------------------------------------------
-- 2. Checks on every new row: trusted time and a flood limit
-- -----------------------------------------------------------------------------
create or replace function public.flowstate_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  max_per_minute constant integer := case when tg_table_name = 'alerts' then 30 else 60 end;
  recent integer;
begin
  new.received_at := now();
  new.device_timestamp := new."timestamp";
  if new."timestamp" is null or abs(extract(epoch from (new."timestamp" - now()))) > 300 then
    new."timestamp" := now();
  end if;

  if tg_table_name = 'alerts' then
    select count(*) into recent from public.alerts where "timestamp" > now() - interval '1 minute';
  else
    select count(*) into recent from public.water_readings where "timestamp" > now() - interval '1 minute';
  end if;
  if recent >= max_per_minute then
    raise exception 'FlowState: too many rows in the last minute for % (limit %)', tg_table_name, max_per_minute
      using errcode = 'P0001';
  end if;
  return new;
end
$$;

drop trigger if exists water_readings_before_insert on public.water_readings;
create trigger water_readings_before_insert
  before insert on public.water_readings
  for each row execute function public.flowstate_before_insert();

drop trigger if exists alerts_before_insert on public.alerts;
create trigger alerts_before_insert
  before insert on public.alerts
  for each row execute function public.flowstate_before_insert();

-- -----------------------------------------------------------------------------
-- 3. Who may do what
-- -----------------------------------------------------------------------------
alter table public.water_readings enable row level security;
alter table public.alerts enable row level security;

-- Supabase gives new tables every privilege by default; keep only read and add.
revoke all on public.water_readings, public.alerts from anon, authenticated;
grant select, insert on public.water_readings, public.alerts to anon, authenticated;

drop policy if exists flowstate_read_readings on public.water_readings;
create policy flowstate_read_readings on public.water_readings
  for select to anon, authenticated using (true);

drop policy if exists flowstate_add_readings on public.water_readings;
create policy flowstate_add_readings on public.water_readings
  for insert to anon, authenticated with check (true);

drop policy if exists flowstate_read_alerts on public.alerts;
create policy flowstate_read_alerts on public.alerts
  for select to anon, authenticated using (true);

drop policy if exists flowstate_add_alerts on public.alerts;
create policy flowstate_add_alerts on public.alerts
  for insert to anon, authenticated with check (true);

-- -----------------------------------------------------------------------------
-- 4. Live updates for the dashboard (Supabase Realtime)
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'water_readings') then
    alter publication supabase_realtime add table public.water_readings;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alerts') then
    alter publication supabase_realtime add table public.alerts;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- 5. Analysis: one row per hour
-- -----------------------------------------------------------------------------
-- used_liters  water drawn through sensor 1, from the rise in daily_total_liters
--              between readings (a drop to a new day's total counts as that total;
--              a drop on the same day, from a reboot or RESET_TOTAL, counts as 0)
-- lost_liters  used_liters x percentage_loss / 100 for each reading
-- flow_readings readings where the tank outlet flow was at least 0.1 L/min
--              (each one stands for about 10 s of flow)
-- avg_rssi, avg_upload_ms, mqtt_share  connectivity health for the hour
-- Hours are in p_tz, the device's home time zone. p_since is limited to 35 days.
-- (Dropped first because its columns grew in v2; it is recreated straight away.)
drop function if exists public.get_hourly_summary(timestamptz, text);
create function public.get_hourly_summary(
  p_since timestamptz default null,
  p_tz    text        default 'Asia/Kolkata'
)
returns table (
  hour_start       timestamptz,
  readings         integer,
  used_liters      numeric,
  lost_liters      numeric,
  flow_readings    integer,
  max_loss_percent numeric,
  avg_flow_1       numeric,
  avg_flow_2       numeric,
  avg_level_cm     numeric,
  avg_humidity     numeric,
  avg_temperature  numeric,
  avg_rssi         numeric,
  avg_upload_ms    numeric,
  mqtt_share       numeric
)
language sql
stable
set search_path = ''
as $$
  with bounds as (
    select greatest(coalesce(p_since, now() - interval '24 hours'), now() - interval '35 days') as since
  ),
  ordered as (
    select w."timestamp", w.daily_total_liters, w.percentage_loss, w.flow_rate_1, w.flow_rate_2,
           w.water_level, w.humidity, w.temperature, w.wifi_rssi, w.upload_ms, w.mqtt_connected,
           lag(w.daily_total_liters) over (order by w."timestamp", w.id) as previous_total,
           lag(w."timestamp")        over (order by w."timestamp", w.id) as previous_time
    from public.water_readings w, bounds b
    where w."timestamp" >= b.since - interval '1 hour'
      and w."timestamp" <= now() + interval '5 minutes'
  ),
  usage as (
    select o.*,
           case
             when o.previous_total is null then 0
             when o.daily_total_liters >= o.previous_total then o.daily_total_liters - o.previous_total
             when (o."timestamp" at time zone p_tz)::date <> (o.previous_time at time zone p_tz)::date
               then o.daily_total_liters
             else 0
           end as used
    from ordered o
  )
  select
    date_trunc('hour', u."timestamp" at time zone p_tz) at time zone p_tz,
    count(*)::integer,
    round(sum(u.used), 3),
    round(sum(u.used * u.percentage_loss / 100), 3),
    (count(*) filter (where u.flow_rate_1 >= 0.1))::integer,
    max(u.percentage_loss),
    round(avg(u.flow_rate_1), 2),
    round(avg(u.flow_rate_2), 2),
    round(avg(u.water_level), 1),
    round(avg(u.humidity), 1),
    round(avg(u.temperature), 1),
    round(avg(u.wifi_rssi), 1),
    round(avg(u.upload_ms), 0),
    round(avg(u.mqtt_connected), 2)
  from usage u, bounds b
  where u."timestamp" >= b.since
  group by 1
  order by 1
$$;

comment on function public.get_hourly_summary(timestamptz, text) is
  'FlowState analysis: water used, water lost and night flow for each hour since p_since.';

revoke all on function public.get_hourly_summary(timestamptz, text) from public;
grant execute on function public.get_hourly_summary(timestamptz, text) to anon, authenticated;

commit;
