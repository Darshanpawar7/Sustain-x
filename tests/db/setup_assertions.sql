-- Tests for supabase/flowstate_setup.sql (the database for the final ESP32
-- sketch). Run with tests/db/run.mjs, which applies the setup twice first.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema if not exists tests;
grant usage on schema tests to public;

create or replace function tests.expect_error(p_sql text, p_sqlstate text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_sqlstate then
      raise notice 'ok - rejected with % as expected: %', p_sqlstate, left(p_sql, 90);
      return;
    end if;
    raise exception 'Expected SQLSTATE % but got % (%) for: %', p_sqlstate, sqlstate, sqlerrm, p_sql;
  end;
  raise exception 'Expected SQLSTATE % but the statement succeeded: %', p_sqlstate, p_sql;
end
$$;

create or replace function tests.check(p_ok boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAILED: %', p_message;
  end if;
  raise notice 'ok - %', p_message;
end
$$;

grant execute on all functions in schema tests to public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'no_grants_setup') then
    create role no_grants_setup nologin;
  end if;
end
$$;

-- Start from empty tables (on a live project this runs inside a transaction
-- that is rolled back, so real readings are not touched).
delete from public.water_readings;
delete from public.alerts;

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select tests.check(
  (select count(*) from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public'
     and tablename in ('water_readings', 'alerts')) = 2,
  'both tables send live updates (Realtime)');

select tests.check(
  has_table_privilege('anon', 'public.water_readings', 'SELECT')
  and has_table_privilege('anon', 'public.water_readings', 'INSERT')
  and not has_table_privilege('anon', 'public.water_readings', 'UPDATE')
  and not has_table_privilege('anon', 'public.water_readings', 'DELETE')
  and not has_table_privilege('anon', 'public.water_readings', 'TRUNCATE'),
  'the public key may read and add readings, nothing else');

select tests.check(
  has_table_privilege('anon', 'public.alerts', 'SELECT')
  and has_table_privilege('anon', 'public.alerts', 'INSERT')
  and not has_table_privilege('anon', 'public.alerts', 'UPDATE')
  and not has_table_privilege('anon', 'public.alerts', 'DELETE')
  and not has_table_privilege('anon', 'public.alerts', 'TRUNCATE'),
  'the public key may read and add alerts, nothing else');

-- ---------------------------------------------------------------------------
-- The final sketch's uploads are accepted as they are
-- ---------------------------------------------------------------------------
set role anon;

-- Exactly the fields sendDataToSupabase() posts, with an India-time timestamp.
insert into public.water_readings
  ("timestamp", flow_rate_1, flow_rate_2, percentage_loss, water_level, valve_state,
   leak_status, anomaly_status, system_online, daily_total_liters)
values
  ((to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30')::timestamptz,
   4.27, 3.98, 6.8, 63.5, 1, 'Warning', 'Learning', 1, 12.3456789);

-- Exactly the fields logAlert() posts.
insert into public.alerts ("timestamp", alert_type, message, severity)
values ((to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS') || '+05:30')::timestamptz,
        'LEAK_WARNING',
        'Flow difference detected. Sensor 1: 4.270 L, Sensor 2: 3.980 L, estimated loss: 6.8%.',
        'medium');

reset role;

select tests.check(
  (select count(*) from public.water_readings) = 1
  and (select daily_total_liters from public.water_readings) = 12.346
  and (select abs(extract(epoch from ("timestamp" - device_timestamp))) from public.water_readings) < 1,
  'a reading from the sketch is stored, with its own time and the total rounded to millilitres');

select tests.check(
  (select humidity is null and temperature is null from public.water_readings),
  'humidity and temperature stay empty when the sketch does not send them');

select tests.check(
  (select count(*) from public.alerts where alert_type = 'LEAK_WARNING' and severity = 'medium') = 1,
  'an alert from the sketch is stored');

-- Firmware v2 also sends the DHT22 values and connectivity health.
set role anon;
insert into public.water_readings
  ("timestamp", flow_rate_1, flow_rate_2, percentage_loss, water_level, valve_state, leak_status,
   anomaly_status, system_online, daily_total_liters, humidity, temperature,
   wifi_rssi, uptime_s, free_heap, upload_ms, http_failures, mqtt_connected)
values
  (now(), 2.1, 2.05, 2.4, 70.25, 1, 'Normal', 'Normal', 1, 20.5, 61.3, 27.4,
   -63, 3600, 182344, 245, 0, 1);
reset role;

select tests.check(
  (select wifi_rssi = -63 and upload_ms = 245 and mqtt_connected = 1 and humidity = 61.3
   from public.water_readings where daily_total_liters = 20.5),
  'a firmware v2 reading with humidity, temperature and connectivity health is stored');

set role anon;
select tests.expect_error($$insert into public.water_readings (wifi_rssi) values (12)$$, '23514');
select tests.expect_error($$insert into public.water_readings (mqtt_connected) values (3)$$, '23514');
select tests.expect_error($$insert into public.water_readings (upload_ms) values (-5)$$, '23514');
reset role;

-- ---------------------------------------------------------------------------
-- The device clock is only trusted when it is close to the server clock
-- ---------------------------------------------------------------------------
set role anon;
insert into public.water_readings ("timestamp", flow_rate_1, daily_total_liters)
values (now() - interval '2 days', 1.5, 3);
reset role;

select tests.check(
  (select abs(extract(epoch from ("timestamp" - now()))) < 5
          and device_timestamp < now() - interval '1 day'
   from public.water_readings where flow_rate_1 = 1.5),
  'a reading with a wrong device clock is stored at arrival time, and the device time is kept');

-- ---------------------------------------------------------------------------
-- Impossible values, edits and deletes are refused
-- ---------------------------------------------------------------------------
set role anon;
select tests.expect_error($$insert into public.water_readings (flow_rate_1) values (500)$$, '23514');
select tests.expect_error($$insert into public.water_readings (flow_rate_2) values (-1)$$, '23514');
select tests.expect_error($$insert into public.water_readings (percentage_loss) values (101)$$, '23514');
select tests.expect_error($$insert into public.water_readings (valve_state) values (2)$$, '23514');
select tests.expect_error($$insert into public.water_readings (leak_status) values ('Broken')$$, '23514');
select tests.expect_error($$insert into public.water_readings (anomaly_status) values ('')$$, '23514');
select tests.expect_error($$insert into public.water_readings (humidity) values (140)$$, '23514');
select tests.expect_error($$insert into public.water_readings (id, flow_rate_1) values (999, 1)$$, '428C9');
select tests.expect_error($$update public.water_readings set flow_rate_1 = 0$$, '42501');
select tests.expect_error($$delete from public.water_readings$$, '42501');
select tests.expect_error($$truncate public.water_readings$$, '42501');
select tests.expect_error($$insert into public.alerts (alert_type, message) values ('<script>', 'x')$$, '23514');
select tests.expect_error($$insert into public.alerts (alert_type, message) values ('LEAK', repeat('x', 501))$$, '23514');
select tests.expect_error($$insert into public.alerts (alert_type, severity) values ('LEAK', 'urgent')$$, '23514');
select tests.expect_error($$update public.alerts set message = 'changed'$$, '42501');
select tests.expect_error($$delete from public.alerts$$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Flood limit: 60 readings and 30 alerts a minute
-- ---------------------------------------------------------------------------
delete from public.water_readings;
delete from public.alerts;

set role anon;
do $$
begin
  for i in 1..60 loop
    insert into public.water_readings (flow_rate_1) values (1);
  end loop;
  for i in 1..30 loop
    insert into public.alerts (alert_type) values ('TEST');
  end loop;
end
$$;
select tests.expect_error($$insert into public.water_readings (flow_rate_1) values (1)$$, 'P0001');
select tests.expect_error($$insert into public.alerts (alert_type) values ('TEST')$$, 'P0001');
reset role;

select tests.check((select count(*) from public.water_readings) = 60, 'the 61st reading in a minute is refused');
select tests.check((select count(*) from public.alerts) = 30, 'the 31st alert in a minute is refused');

-- ---------------------------------------------------------------------------
-- Hourly analysis
-- ---------------------------------------------------------------------------
delete from public.water_readings;

-- Old readings can only be written with the time check switched off.
alter table public.water_readings disable trigger water_readings_before_insert;
insert into public.water_readings ("timestamp", daily_total_liters, percentage_loss, flow_rate_1, flow_rate_2, wifi_rssi, upload_ms, mqtt_connected) values
  -- 23:00-23:59 India time, two days ago: 0 (first row) + 5 = 5 L used
  ((current_date - 2 + time '23:10') at time zone 'Asia/Kolkata', 10, 10, 2.0, 1.8, -60, 200, 1),
  ((current_date - 2 + time '23:30') at time zone 'Asia/Kolkata', 15, 10, 2.0, 1.8, -70, 300, 0),
  -- 00:00-00:59 the next day: new day starts at 2 (counts 2), +3, reboot drop (0), +2 = 7 L used
  ((current_date - 1 + time '00:10') at time zone 'Asia/Kolkata', 2, 10, 1.0, 0.9, null, null, null),
  ((current_date - 1 + time '00:20') at time zone 'Asia/Kolkata', 5, 10, 0.0, 0.0, null, null, null),
  ((current_date - 1 + time '00:30') at time zone 'Asia/Kolkata', 4, 10, 0.0, 0.0, null, null, null),
  ((current_date - 1 + time '00:40') at time zone 'Asia/Kolkata', 6, 10, 0.5, 0.5, null, null, null),
  -- 03:00-03:59: night flow
  ((current_date - 1 + time '03:00') at time zone 'Asia/Kolkata', 6.4, 0, 0.3, 0.3, null, null, null),
  ((current_date - 1 + time '03:00:10') at time zone 'Asia/Kolkata', 6.5, 0, 0.3, 0.3, null, null, null);
alter table public.water_readings enable trigger water_readings_before_insert;

set role anon;
create temporary table summary as
  select * from public.get_hourly_summary(now() - interval '3 days', 'Asia/Kolkata');
reset role;

select tests.check((select count(*) from summary) = 3, 'one summary row per hour that has readings');

select tests.check(
  (select used_liters = 5 and lost_liters = 0.5 and readings = 2 and flow_readings = 2
   from summary where hour_start = (current_date - 2 + time '23:00') at time zone 'Asia/Kolkata'),
  'usage in an hour is the rise in the daily total; loss is usage x loss %');

select tests.check(
  (select used_liters = 7 and lost_liters = 0.7 and flow_readings = 2
   from summary where hour_start = (current_date - 1 + time '00:00') at time zone 'Asia/Kolkata'),
  'a new day counts its starting total; a drop on the same day counts as zero');

select tests.check(
  (select used_liters = 0.5 and lost_liters = 0 and flow_readings = 2 and max_loss_percent = 0
   from summary where hour_start = (current_date - 1 + time '03:00') at time zone 'Asia/Kolkata'),
  'night flow is counted in its own hour');

select tests.check(
  (select avg_rssi = -65 and avg_upload_ms = 250 and mqtt_share = 0.5
   from summary where hour_start = (current_date - 2 + time '23:00') at time zone 'Asia/Kolkata'),
  'connectivity health is averaged for each hour');

select tests.check(
  (select count(*) from public.get_hourly_summary(now() - interval '3 days', 'UTC')) = 4
  and (select min(hour_start) from public.get_hourly_summary(now() - interval '3 days', 'UTC'))
      = (current_date - 2 + time '23:00') at time zone 'Asia/Kolkata' - interval '30 minutes',
  'hours follow the requested time zone (India is UTC+05:30)');

select tests.check(
  (select count(*) from public.get_hourly_summary(now() - interval '1 hour', 'Asia/Kolkata')) = 0,
  'only hours since p_since are returned');

select tests.expect_error($$select * from public.get_hourly_summary(now() - interval '3 days', 'Not/AZone')$$, '22023');

select tests.check(
  not has_function_privilege('no_grants_setup', 'public.get_hourly_summary(timestamptz, text)', 'EXECUTE'),
  'only the Supabase roles may call the analysis function');

\echo 'All setup tests passed.'
