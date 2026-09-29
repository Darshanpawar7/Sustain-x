-- Migration 006: Secret keys for the device and for dashboard operators
--
-- Keys are stored only as SHA-256 hashes, in a "private" schema that the
-- Supabase API does not expose. Create keys from the Supabase SQL editor:
--
--   select private.create_access_key('esp32-main', 'device');       -- goes in the firmware's secrets.h
--   select private.create_access_key('operator-laptop', 'operator'); -- entered in the dashboard to move the valve
--
-- The plain key is shown once, when it is created. To replace a key:
--   select private.revoke_access_key('esp32-main');
--   select private.create_access_key('esp32-main-2', 'device');

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.access_keys (
  id bigint generated always as identity primary key,
  label text not null unique check (char_length(label) between 1 and 64),
  role text not null check (role in ('device', 'operator')),
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create or replace function private.hash_access_key(p_key text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(extensions.digest(p_key, 'sha256'), 'hex');
$$;

-- Creates a random 48-character key, stores its hash, and returns the key once.
create or replace function private.create_access_key(p_label text, p_role text)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_key text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  insert into private.access_keys (label, role, key_hash)
  values (p_label, p_role, private.hash_access_key(v_key));
  return v_key;
end;
$$;

create or replace function private.revoke_access_key(p_label text)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
begin
  update private.access_keys
     set revoked_at = now()
   where label = p_label
     and revoked_at is null;
  return found;
end;
$$;

-- Returns the key's id when p_key is a valid, unrevoked key with role p_role, otherwise null.
create or replace function private.verify_access_key(p_key text, p_role text)
returns bigint
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_key is null or char_length(p_key) not between 32 and 128 then
    return null;
  end if;

  select id
    into v_id
    from private.access_keys
   where key_hash = private.hash_access_key(p_key)
     and role = p_role
     and revoked_at is null;

  if v_id is not null then
    -- Record usage at most once a minute to avoid a write on every upload.
    update private.access_keys
       set last_used_at = now()
     where id = v_id
       and (last_used_at is null or last_used_at < now() - interval '1 minute');
  end if;

  return v_id;
end;
$$;

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
