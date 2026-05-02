-- Migration 004: Add humidity support for DHT22 telemetry

alter table public.water_readings
  add column if not exists humidity numeric(5,2) not null default 0
  check (humidity >= 0 and humidity <= 100);
