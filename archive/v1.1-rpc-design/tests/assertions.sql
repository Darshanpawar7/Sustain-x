-- Database behaviour tests. Run with tests/db/run.mjs (needs psql).
\set ON_ERROR_STOP 1
set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
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
  if not exists (select 1 from pg_roles where rolname = 'no_grants') then
    create role no_grants nologin;
  end if;
end
$$;

select private.create_access_key('test-device', 'device') as device_key \gset
select private.create_access_key('test-operator', 'operator') as operator_key \gset
select private.create_access_key('revoked-device', 'device') as revoked_key \gset
select tests.check(private.revoke_access_key('revoked-device'), 'a key can be revoked');

-- ---------------------------------------------------------------------------
-- The public key can no longer write directly
-- ---------------------------------------------------------------------------
set role anon;
select tests.expect_error($$insert into public.water_readings (flow_rate_1) values (1)$$, '42501');
select tests.expect_error($$insert into public.alerts (alert_type, message) values ('FAKE', 'fake')$$, '42501');
select tests.expect_error($$update public.water_readings set flow_rate_1 = 0$$, '42501');
select tests.expect_error($$delete from public.alerts$$, '42501');
select tests.expect_error($$insert into public.valve_commands (action, requested_by_key_id) values ('open', 1)$$, '42501');
select tests.expect_error($$select * from private.access_keys$$, '42501');
select tests.expect_error($$select private.create_access_key('sneaky', 'operator')$$, '42501');
select tests.expect_error($$select private.purge_old_data()$$, '42501');
reset role;

set role authenticated;
select tests.expect_error($$insert into public.alerts (alert_type, message) values ('FAKE', 'fake')$$, '42501');
reset role;

set role no_grants;
select tests.expect_error(
  format($$select public.ingest_reading(%L, 1, 1, 0, 10, 1, 'Normal', 'Learning')$$, :'device_key'),
  '42501');
reset role;

-- ---------------------------------------------------------------------------
-- ingest_reading checks the device key and validates input
-- ---------------------------------------------------------------------------
set role anon;
select tests.expect_error(
  $$select public.ingest_reading('not-a-real-key-not-a-real-key-0000', 1, 1, 0, 10, 1, 'Normal', 'Learning')$$,
  '28000');
select tests.expect_error(
  format($$select public.ingest_reading(%L, 1, 1, 0, 10, 1, 'Normal', 'Learning')$$, :'revoked_key'),
  '28000');
select tests.expect_error(
  format($$select public.ingest_reading(%L, 1, 1, 0, 10, 1, 'Normal', 'Learning')$$, :'operator_key'),
  '28000');
select tests.expect_error(
  format($$select public.ingest_reading(%L, 1, 1, 0, 10, 1, 'critical', 'Learning')$$, :'device_key'),
  '22023');
select tests.expect_error(
  format($$select public.ingest_reading(%L, 1, 1, 0, 10, 2, 'Normal', 'Learning')$$, :'device_key'),
  '22023');
select tests.expect_error(
  format($$select public.ingest_reading(%L, 1, 1, 0, 10, 1, 'Normal', 'Confused')$$, :'device_key'),
  '22023');

select public.ingest_reading(:'device_key', 2.5, 2.4, 4, 42.5, 1, 'Normal', 'Learning', 1.25, null, 41.67, 40.0)
  as first_ingest \gset
select public.ingest_reading(:'device_key', -5, 5000, 250, 12, 0, 'Critical', 'Normal', 3, 180, -1, 0)
  as clamped_ingest \gset
reset role;

select tests.check((:'first_ingest'::jsonb ->> 'ok')::boolean, 'the device can store a reading with its key');
select tests.check((:'first_ingest'::jsonb -> 'command') = 'null'::jsonb, 'no valve command is pending at first');
select tests.check(
  (select abs(extract(epoch from (r.timestamp - now()))) < 10
          and r.humidity is null
          and r.volume_1_ml = 41.67
          and r.volume_2_ml = 40.00
     from public.water_readings r
    where r.id = (:'first_ingest'::jsonb ->> 'reading_id')::bigint),
  'the server sets the timestamp and stores volumes and unknown humidity');
select tests.check(
  (select r.flow_rate_1 = 0 and r.flow_rate_2 = 1000 and r.percentage_loss = 100
          and r.humidity = 100 and r.volume_1_ml = 0
     from public.water_readings r
    where r.id = (:'clamped_ingest'::jsonb ->> 'reading_id')::bigint),
  'out-of-range numbers are clamped instead of rejected');

-- ---------------------------------------------------------------------------
-- log_device_alert
-- ---------------------------------------------------------------------------
set role anon;
select public.log_device_alert(:'device_key', 'CRITICAL_LEAK', 'Loss 22.0% - valve closed', 'critical') as alert_one \gset
select public.log_device_alert(:'device_key', 'LONG_MESSAGE', repeat('a', 900), 'low') as alert_long \gset
select tests.expect_error(
  format($$select public.log_device_alert(%L, '<img src=x onerror=alert(1)>', 'x', 'low')$$, :'device_key'),
  '22023');
select tests.expect_error(
  format($$select public.log_device_alert(%L, 'SOME_TYPE', 'x', 'urgent')$$, :'device_key'),
  '22023');
select tests.expect_error(
  format($$select public.log_device_alert(%L, 'SOME_TYPE', 'x', 'low')$$, :'operator_key'),
  '28000');
reset role;

select tests.check(
  (select severity = 'critical' from public.alerts where id = (:'alert_one'::jsonb ->> 'alert_id')::bigint),
  'the device can log a critical alert');
select tests.check(
  (select char_length(message) = 500 from public.alerts where id = (:'alert_long'::jsonb ->> 'alert_id')::bigint),
  'long alert messages are cut to 500 characters');

-- ---------------------------------------------------------------------------
-- Remote valve commands
-- ---------------------------------------------------------------------------
set role anon;
select tests.expect_error(
  format($$select public.request_valve_command(%L, 'close')$$, :'device_key'),
  '28000');
select tests.expect_error(
  format($$select public.request_valve_command(%L, 'explode')$$, :'operator_key'),
  '22023');
select public.request_valve_command(:'operator_key', 'open') as command_one \gset
select public.request_valve_command(:'operator_key', 'close') as command_two \gset
reset role;

select tests.check(
  (select status = 'expired' from public.valve_commands where id = (:'command_one'::jsonb ->> 'command_id')::bigint),
  'a newer command replaces one the device has not collected');

set role anon;
select public.ingest_reading(:'device_key', 0, 0, 0, 40, 1, 'Normal', 'Learning') as with_command \gset
select public.ingest_reading(:'device_key', 0, 0, 0, 40, 0, 'Normal', 'Learning') as after_command \gset
reset role;

select tests.check(
  (:'with_command'::jsonb -> 'command' ->> 'action') = 'close'
  and (:'with_command'::jsonb -> 'command' ->> 'id')::bigint = (:'command_two'::jsonb ->> 'command_id')::bigint,
  'the device receives the pending command with its next reading');
select tests.check((:'after_command'::jsonb -> 'command') = 'null'::jsonb, 'a delivered command is not sent twice');
select tests.check(
  (select status = 'delivered' and delivered_at is not null
     from public.valve_commands where id = (:'command_two'::jsonb ->> 'command_id')::bigint),
  'the command is marked delivered');

set role anon;
select public.request_valve_command(:'operator_key', 'open') as stale_command \gset
reset role;
update public.valve_commands
   set requested_at = now() - interval '3 minutes'
 where id = (:'stale_command'::jsonb ->> 'command_id')::bigint;
set role anon;
select public.ingest_reading(:'device_key', 0, 0, 0, 40, 0, 'Normal', 'Learning') as stale_check \gset
reset role;
select tests.check(
  (:'stale_check'::jsonb -> 'command') = 'null'::jsonb
  and (select status = 'expired' from public.valve_commands where id = (:'stale_command'::jsonb ->> 'command_id')::bigint),
  'commands older than 2 minutes expire instead of running late');

-- Two commands were made in the last minute; four more reach the limit of six.
set role anon;
select tests.check((public.request_valve_command(:'operator_key', 'open') ->> 'ok')::boolean, 'rate limit setup 3/6');
select tests.check((public.request_valve_command(:'operator_key', 'close') ->> 'ok')::boolean, 'rate limit setup 4/6');
select tests.check((public.request_valve_command(:'operator_key', 'open') ->> 'ok')::boolean, 'rate limit setup 5/6');
select tests.check((public.request_valve_command(:'operator_key', 'close') ->> 'ok')::boolean, 'rate limit setup 6/6');
select tests.expect_error(
  format($$select public.request_valve_command(%L, 'open')$$, :'operator_key'),
  'P0001');
reset role;

-- ---------------------------------------------------------------------------
-- Reading access for the dashboard
-- ---------------------------------------------------------------------------
set role anon;
select tests.check((select count(*) > 0 from public.water_readings), 'the public key can read readings');
select tests.check((select count(*) > 0 from public.alerts), 'the public key can read alerts');
select tests.check(
  (select count(*) > 0 from (select id, action, status, requested_at, delivered_at from public.valve_commands) c),
  'the public key can read valve command status');
select tests.expect_error($$select requested_by_key_id from public.valve_commands$$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Alert text and flood limits (a stolen device key cannot flood the database)
-- ---------------------------------------------------------------------------
set role anon;
select public.log_device_alert(:'device_key', 'MARKUP_TEST', '<b>hi</b> <script>x</script>', 'low') as markup_alert \gset
reset role;
select tests.check(
  (select message !~ '[<>]' from public.alerts where id = (:'markup_alert'::jsonb ->> 'alert_id')::bigint),
  'angle brackets are removed from alert messages');

insert into public.water_readings (timestamp, leak_status, anomaly_status, valve_state)
select now() - interval '20 seconds', 'Normal', 'Normal', 1
  from generate_series(1, 30 - (select count(*) from public.water_readings
                                 where timestamp > now() - interval '1 minute' and timestamp <= now())::int);
set role anon;
select tests.expect_error(
  format($$select public.ingest_reading(%L, 1, 1, 0, 10, 1, 'Normal', 'Learning')$$, :'device_key'),
  'P0001');
reset role;
update public.water_readings set timestamp = timestamp - interval '2 minutes'
 where timestamp > now() - interval '1 minute' and timestamp <= now();
set role anon;
select tests.check(
  (public.ingest_reading(:'device_key', 1, 1, 0, 10, 1, 'Normal', 'Learning') ->> 'ok')::boolean,
  'readings are accepted again once the flood limit window has passed');
reset role;

insert into public.alerts (timestamp, alert_type, message, severity)
select now() - interval '20 seconds', 'FILLER', 'filler', 'low'
  from generate_series(1, 20 - (select count(*) from public.alerts
                                 where timestamp > now() - interval '1 minute' and timestamp <= now())::int);
set role anon;
select tests.expect_error(
  format($$select public.log_device_alert(%L, 'ONE_TOO_MANY', 'x', 'low')$$, :'device_key'),
  'P0001');
reset role;

select tests.check(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.water_readings'::regclass, 'public.alerts'::regclass, 'public.valve_commands'::regclass)),
  'row-level security is on for every public table');
select tests.check(
  (select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
    where oid in ('public.ingest_reading'::regproc, 'public.log_device_alert'::regproc, 'public.request_valve_command'::regproc)),
  'write functions run as definer with an empty search_path');
select tests.check(
  (select count(*) = 2 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('water_readings', 'alerts')),
  'readings and alerts are published to Realtime');

-- ---------------------------------------------------------------------------
-- History and usage summaries
-- ---------------------------------------------------------------------------
insert into public.water_readings
  (timestamp, flow_rate_1, flow_rate_2, percentage_loss, water_level, humidity,
   valve_state, leak_status, anomaly_status, volume_1_ml, volume_2_ml)
values
  (now() - interval '30 minutes',               3, 2.7, 10, 50, 40, 1, 'Warning',  'Normal', 1000, 900),
  (now() - interval '30 minutes' + interval '5 seconds', 3, 2.7, 10, 50, 40, 1, 'Warning',  'Normal', 1000, 900),
  (now() - interval '2 hours',                  1, 1,    0, 50, 40, 1, 'Normal',   'Normal',  500, 500),
  (now() + interval '2 days',                   9, 0,  100,  1,  1, 1, 'Critical', 'Normal', 99999,  0),
  (now() - interval '40 days',                  1, 1,    0, 50, 40, 1, 'Normal',   'Normal',  100, 100);

set role anon;
select tests.check(
  (select coalesce(sum(volume_1_liters), 0) >= 2.0 from public.get_reading_history('1h')),
  '1h history includes the last hour''s volume');
select tests.check(
  (select count(*) = 0 from public.get_reading_history('24h') where bucket_start > now() + interval '1 minute'),
  'future-dated rows are left out of charts');
select tests.check(
  (select coalesce(sum(volume_1_liters), 0) >= 2.5 from public.get_reading_history('24h')),
  '24h history reaches back further than the last 10 minutes');
select tests.expect_error($$select * from public.get_reading_history('bogus')$$, '22023');
select tests.check(
  (select total_1_liters >= 2.0 and loss_liters >= 0.2 from public.get_usage_summary(now() - interval '1 hour')),
  'the usage summary totals volume and loss');
reset role;

-- ---------------------------------------------------------------------------
-- Valve command queue integrity and key usage tracking
-- ---------------------------------------------------------------------------
update public.valve_commands set status = 'expired' where status = 'pending';
insert into public.valve_commands (action, requested_by_key_id)
select 'open', id from private.access_keys where label = 'test-operator';
select tests.expect_error(
  $$insert into public.valve_commands (action, requested_by_key_id)
    select 'close', id from private.access_keys where label = 'test-operator'$$,
  '23505');
update public.valve_commands set status = 'expired' where status = 'pending';

select tests.check(
  (select last_used_at is not null from private.access_keys where label = 'test-device'),
  'key use is recorded');
update private.access_keys set last_used_at = now() - interval '2 minutes' where label = 'test-device';
select private.verify_access_key(:'device_key', 'device') is not null as verified \gset
select tests.check(
  :'verified'::boolean
  and (select last_used_at > now() - interval '5 seconds' from private.access_keys where label = 'test-device'),
  'key use is refreshed after a minute');
update private.access_keys set last_used_at = now() - interval '30 seconds' where label = 'test-device';
select private.verify_access_key(:'device_key', 'device') is not null as verified_again \gset
select tests.check(
  (select last_used_at < now() - interval '20 seconds' from private.access_keys where label = 'test-device'),
  'key use is not rewritten more than once a minute');

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------
insert into public.alerts (timestamp, alert_type, message, severity)
values (now() - interval '200 days', 'OLD_ALERT', 'old', 'low');
insert into public.valve_commands (action, status, requested_at, requested_by_key_id)
select 'open', 'expired', now() - interval '40 days', id from private.access_keys where label = 'test-operator';

select private.purge_old_data() as purge_result \gset
select tests.check((:'purge_result'::jsonb ->> 'readings')::int >= 2, 'purge removes old and future-dated readings');
select tests.check((:'purge_result'::jsonb ->> 'alerts')::int >= 1, 'purge removes alerts older than 180 days');
select tests.check((:'purge_result'::jsonb ->> 'valve_commands')::int >= 1, 'purge removes commands older than 30 days');
select tests.check(
  (select count(*) = 0 from public.water_readings
    where timestamp > now() + interval '1 day' or timestamp < now() - interval '30 days'),
  'no out-of-range readings remain after purge');

select 'ALL DATABASE TESTS PASSED' as result;
