-- Migration 005: Stop public clients from writing directly
--
-- Before this migration the public (anon) key, which every dashboard visitor
-- receives, could insert rows into water_readings and alerts. That allowed
-- fake readings, fake alerts and script injection into the dashboard.
--
-- From now on the public key is read-only. The device writes through the
-- key-checked functions added in migration 007.

-- 1. Remove every direct write path for anon/authenticated clients.
drop policy if exists "water_readings_insert_anon" on public.water_readings;
drop policy if exists "water_readings_insert_authenticated" on public.water_readings;
drop policy if exists "alerts_insert_anon" on public.alerts;
drop policy if exists "alerts_insert_authenticated" on public.alerts;

-- Supabase grants ALL on new public tables by default, so revoke explicitly.
revoke insert, update, delete, truncate, references, trigger
  on public.water_readings, public.alerts
  from anon, authenticated;

revoke usage, select, update
  on sequence public.water_readings_id_seq, public.alerts_id_seq
  from anon, authenticated;

-- 2. Volume measured by each sensor since the device's previous upload.
--    Summing these gives exact totals for any period, even across reboots.
alter table public.water_readings
  add column if not exists volume_1_ml numeric(12,2) not null default 0 check (volume_1_ml >= 0),
  add column if not exists volume_2_ml numeric(12,2) not null default 0 check (volume_2_ml >= 0);

-- 3. Humidity can be unknown (sensor missing or no valid reading yet).
alter table public.water_readings alter column humidity drop not null;
alter table public.water_readings alter column humidity drop default;

-- 4. Constrain free-text columns for new rows. NOT VALID leaves existing rows alone.
alter table public.water_readings drop constraint if exists water_readings_anomaly_status_check;
alter table public.water_readings
  add constraint water_readings_anomaly_status_check
  check (anomaly_status in ('Learning', 'Normal', 'Anomaly Detected')) not valid;

alter table public.alerts drop constraint if exists alerts_alert_type_format_check;
alter table public.alerts
  add constraint alerts_alert_type_format_check
  check (alert_type ~ '^[A-Z0-9_]{1,64}$') not valid;

alter table public.alerts drop constraint if exists alerts_message_length_check;
alter table public.alerts
  add constraint alerts_message_length_check
  check (char_length(message) <= 500) not valid;

notify pgrst, 'reload schema';
