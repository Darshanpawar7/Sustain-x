-- Migration 007: Key-checked write functions and remote valve commands
--
-- The device calls:
--   POST /rest/v1/rpc/ingest_reading     (one reading; the reply carries any pending valve command)
--   POST /rest/v1/rpc/log_device_alert   (one alert)
-- The dashboard calls:
--   POST /rest/v1/rpc/request_valve_command   (needs an operator key)
--
-- All timestamps are set by the database, so device clocks and time zones
-- cannot put rows in the future.

-- ---------------------------------------------------------------------------
-- Valve commands queued by the dashboard and collected by the device
-- ---------------------------------------------------------------------------
create table if not exists public.valve_commands (
  id bigint generated always as identity primary key,
  action text not null check (action in ('open', 'close')),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'expired')),
  requested_at timestamptz not null default now(),
  delivered_at timestamptz,
  requested_by_key_id bigint not null references private.access_keys (id)
);

create index if not exists idx_valve_commands_pending
  on public.valve_commands (requested_at)
  where status = 'pending';

-- At most one command may wait for the device, so an old one can never run late.
create unique index if not exists valve_commands_one_pending
  on public.valve_commands ((true))
  where status = 'pending';

alter table public.valve_commands enable row level security;

-- The dashboard may see a command's progress, but not which key asked for it.
revoke all on public.valve_commands from anon, authenticated;
grant select (id, action, status, requested_at, delivered_at) on public.valve_commands to anon, authenticated;

drop policy if exists "valve_commands_select_all" on public.valve_commands;
create policy "valve_commands_select_all"
  on public.valve_commands
  for select
  to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------------
-- ingest_reading: store one reading and hand back any pending valve command
-- ---------------------------------------------------------------------------
create or replace function public.ingest_reading(
  p_device_key text,
  p_flow_rate_1 numeric,
  p_flow_rate_2 numeric,
  p_percentage_loss numeric,
  p_water_level numeric,
  p_valve_state integer,
  p_leak_status text,
  p_anomaly_status text,
  p_daily_total_liters numeric default 0,
  p_humidity numeric default null,
  p_volume_1_ml numeric default 0,
  p_volume_2_ml numeric default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reading_id bigint;
  v_command_id bigint;
  v_command_action text;
begin
  if private.verify_access_key(p_device_key, 'device') is null then
    raise exception 'Invalid or revoked device key' using errcode = '28000';
  end if;

  if p_valve_state is null or p_valve_state not in (0, 1) then
    raise exception 'valve_state must be 0 (closed) or 1 (open)' using errcode = '22023';
  end if;
  if p_leak_status is null or p_leak_status not in ('Normal', 'Warning', 'Critical') then
    raise exception 'leak_status must be Normal, Warning or Critical' using errcode = '22023';
  end if;
  if p_anomaly_status is null or p_anomaly_status not in ('Learning', 'Normal', 'Anomaly Detected') then
    raise exception 'anomaly_status must be Learning, Normal or Anomaly Detected' using errcode = '22023';
  end if;

  -- The device sends about 12 readings a minute. A copied device key must not
  -- be able to flood the table.
  if (select count(*)
        from public.water_readings
       where timestamp > now() - interval '1 minute'
         and timestamp <= now()) >= 30 then
    raise exception 'Readings are arriving too fast (more than 30 a minute).';
  end if;

  -- Clamp numbers so one bad sensor sample cannot make the whole upload fail.
  insert into public.water_readings (
    timestamp, flow_rate_1, flow_rate_2, percentage_loss, water_level, humidity,
    valve_state, leak_status, anomaly_status, system_online, daily_total_liters,
    volume_1_ml, volume_2_ml
  ) values (
    now(),
    least(greatest(coalesce(p_flow_rate_1, 0), 0), 1000),
    least(greatest(coalesce(p_flow_rate_2, 0), 0), 1000),
    least(greatest(coalesce(p_percentage_loss, 0), 0), 100),
    least(greatest(coalesce(p_water_level, 0), 0), 100000),
    case when p_humidity is null then null else least(greatest(p_humidity, 0), 100) end,
    p_valve_state,
    p_leak_status,
    p_anomaly_status,
    1,
    least(greatest(coalesce(p_daily_total_liters, 0), 0), 999999999),
    least(greatest(coalesce(p_volume_1_ml, 0), 0), 9999999999),
    least(greatest(coalesce(p_volume_2_ml, 0), 0), 9999999999)
  )
  returning id into v_reading_id;

  -- Commands the device did not collect within 2 minutes are too old to act on.
  update public.valve_commands
     set status = 'expired'
   where status = 'pending'
     and requested_at < now() - interval '2 minutes';

  select id, action
    into v_command_id, v_command_action
    from public.valve_commands
   where status = 'pending'
   order by requested_at desc
   limit 1
   for update skip locked;

  if v_command_id is not null then
    update public.valve_commands
       set status = 'delivered',
           delivered_at = now()
     where id = v_command_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reading_id', v_reading_id,
    'command', case
                 when v_command_id is null then null
                 else jsonb_build_object('id', v_command_id, 'action', v_command_action)
               end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- log_device_alert: store one alert from the device
-- ---------------------------------------------------------------------------
create or replace function public.log_device_alert(
  p_device_key text,
  p_alert_type text,
  p_message text,
  p_severity text default 'medium'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_alert_id bigint;
begin
  if private.verify_access_key(p_device_key, 'device') is null then
    raise exception 'Invalid or revoked device key' using errcode = '28000';
  end if;

  if p_alert_type is null or p_alert_type !~ '^[A-Z0-9_]{1,64}$' then
    raise exception 'alert_type must be 1-64 characters of A-Z, 0-9 or _' using errcode = '22023';
  end if;
  if p_severity is null or p_severity not in ('low', 'medium', 'high', 'critical') then
    raise exception 'severity must be low, medium, high or critical' using errcode = '22023';
  end if;

  if (select count(*)
        from public.alerts
       where timestamp > now() - interval '1 minute'
         and timestamp <= now()) >= 20 then
    raise exception 'Too many alerts in the last minute.';
  end if;

  -- Messages are plain text. Angle brackets are dropped so the text stays
  -- harmless even if a future tool shows it as HTML.
  insert into public.alerts (timestamp, alert_type, message, severity)
  values (
    now(),
    p_alert_type,
    left(regexp_replace(coalesce(nullif(btrim(p_message), ''), p_alert_type), '[<>]', '', 'g'), 500),
    p_severity
  )
  returning id into v_alert_id;

  return jsonb_build_object('ok', true, 'alert_id', v_alert_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- request_valve_command: queue an open/close command (operator key required)
-- ---------------------------------------------------------------------------
create or replace function public.request_valve_command(p_operator_key text, p_action text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key_id bigint;
  v_recent_count integer;
  v_command_id bigint;
begin
  v_key_id := private.verify_access_key(p_operator_key, 'operator');
  if v_key_id is null then
    raise exception 'Invalid or revoked operator key' using errcode = '28000';
  end if;

  if p_action is null or p_action not in ('open', 'close') then
    raise exception 'action must be open or close' using errcode = '22023';
  end if;

  -- One request at a time: without this, two requests at the same moment could
  -- both stay pending and the older one would run after the newer one.
  perform pg_advisory_xact_lock(hashtext('flowstate.valve_commands'));

  -- Protect the valve from rapid toggling.
  select count(*)
    into v_recent_count
    from public.valve_commands
   where requested_at > now() - interval '1 minute';
  if v_recent_count >= 6 then
    raise exception 'Too many valve commands in the last minute. Wait a moment and try again.';
  end if;

  -- The newest command replaces any the device has not collected yet.
  update public.valve_commands
     set status = 'expired'
   where status = 'pending';

  insert into public.valve_commands (action, requested_by_key_id)
  values (p_action, v_key_id)
  returning id into v_command_id;

  return jsonb_build_object('ok', true, 'command_id', v_command_id, 'action', p_action, 'status', 'pending');
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions: callable with the public key; the secret key is checked inside.
-- ---------------------------------------------------------------------------
revoke all on function public.ingest_reading from public;
revoke all on function public.log_device_alert from public;
revoke all on function public.request_valve_command from public;

grant execute on function public.ingest_reading to anon, authenticated, service_role;
grant execute on function public.log_device_alert to anon, authenticated, service_role;
grant execute on function public.request_valve_command to anon, authenticated, service_role;

notify pgrst, 'reload schema';
