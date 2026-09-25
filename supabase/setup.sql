-- Clock backend setup.
-- Paste into the Supabase SQL editor and run. Safe to run again: every
-- statement is idempotent, and the existing clock row is left untouched.
--
-- Model (see README.md):
--   displayed = anchor_clock_time + (server_now - anchor_real_time) * speed
-- anchor_real_time is always set with the database's now(), never from a
-- browser, so it doesn't depend on anyone's device clock.


-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.clock_state (
  id                smallint primary key default 1 check (id = 1),  -- single row
  anchor_real_time  timestamptz not null default now(),
  anchor_clock_time timestamptz not null default now(),
  speed             double precision not null default 1
                    check (speed > '-Infinity' and speed < 'Infinity'),  -- also rejects NaN
  timezone          text not null default 'Europe/Stockholm'
);

-- Seed: real time at normal speed. Change the timezone here or later via set_clock().
insert into public.clock_state (id, anchor_real_time, anchor_clock_time, speed, timezone)
values (1, now(), now(), 1, 'Europe/Stockholm')
on conflict (id) do nothing;

-- Emails of users allowed to change the clock. Not readable through the API.
create table if not exists public.admins (
  email text primary key check (email = lower(email))
);


-- ---------------------------------------------------------------------------
-- 2. Row Level Security and table privileges
-- ---------------------------------------------------------------------------

alter table public.clock_state enable row level security;
alter table public.admins enable row level security;

-- Anyone may read the clock. With no insert/update/delete policies, direct
-- writes are refused; changes go through the functions below.
drop policy if exists "Anyone can read the clock" on public.clock_state;
create policy "Anyone can read the clock"
  on public.clock_state
  for select
  to anon, authenticated
  using (true);

-- Remove the write privileges too (second layer on top of RLS).
revoke insert, update, delete, truncate on public.clock_state from anon, authenticated;
grant select on public.clock_state to anon, authenticated;

-- admins: no policies and no privileges, so it is invisible to the API.
revoke all on public.admins from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. Server time
-- ---------------------------------------------------------------------------

-- Visitors call this to estimate the offset between their device and the server.
create or replace function public.get_server_time()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select now();
$$;

revoke all on function public.get_server_time() from public;
grant execute on function public.get_server_time() to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. Admin functions
-- ---------------------------------------------------------------------------

-- True when the caller is signed in with an email listed in public.admins.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admins
    where email = lower(auth.jwt() ->> 'email')
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;


-- Sets the clock. anchor_real_time is always the server's now().
-- A null argument keeps the current value:
--   new_clock_time null -> keep the time currently displayed (no jump)
--   new_speed      null -> keep the current speed
--   new_timezone   null -> keep the current timezone
-- Returns the new state.
create or replace function public.set_clock(
  new_clock_time timestamptz default null,
  new_speed      double precision default null,
  new_timezone   text default null
)
returns public.clock_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.clock_state;
begin
  if not public.is_admin() then
    raise exception 'Only admins can change the clock' using errcode = '42501';
  end if;

  if new_speed is not null and not (new_speed > '-Infinity' and new_speed < 'Infinity') then
    raise exception 'Speed must be a finite number' using errcode = '22023';
  end if;

  if new_timezone is not null
     and not exists (select 1 from pg_catalog.pg_timezone_names where name = new_timezone) then
    raise exception 'Unknown timezone: %', new_timezone using errcode = '22023';
  end if;

  -- On the right-hand side, c.* are the old values, so the displayed time is
  -- computed with the old anchor and old speed.
  update public.clock_state as c
  set anchor_clock_time = coalesce(
        new_clock_time,
        c.anchor_clock_time + (now() - c.anchor_real_time) * c.speed
      ),
      anchor_real_time = now(),
      speed = coalesce(new_speed, c.speed),
      timezone = coalesce(new_timezone, c.timezone)
  where c.id = 1
  returning c.* into result;

  if result is null then
    raise exception 'clock_state row is missing; run setup.sql again';
  end if;

  return result;
end;
$$;

revoke all on function public.set_clock(timestamptz, double precision, text) from public, anon;
grant execute on function public.set_clock(timestamptz, double precision, text) to authenticated;


-- Changes only the speed, re-anchoring at the time displayed right now on
-- the server so the clock doesn't jump.
create or replace function public.set_clock_speed(new_speed double precision)
returns public.clock_state
language plpgsql
set search_path = ''
as $$
begin
  if new_speed is null then
    raise exception 'Speed is required' using errcode = '22023';
  end if;
  return public.set_clock(null, new_speed, null);  -- checks is_admin()
end;
$$;

revoke all on function public.set_clock_speed(double precision) from public, anon;
grant execute on function public.set_clock_speed(double precision) to authenticated;


-- Back to real time at normal speed, using the server's clock. Keeps the timezone.
create or replace function public.reset_clock()
returns public.clock_state
language plpgsql
set search_path = ''
as $$
begin
  return public.set_clock(now(), 1, null);  -- checks is_admin()
end;
$$;

revoke all on function public.reset_clock() from public, anon;
grant execute on function public.reset_clock() to authenticated;


-- ---------------------------------------------------------------------------
-- 5. Realtime
-- ---------------------------------------------------------------------------

-- Broadcast row changes to subscribed browsers. Realtime respects the
-- select policy above, so anonymous visitors receive updates.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'clock_state'
  ) then
    alter publication supabase_realtime add table public.clock_state;
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. Admins
-- ---------------------------------------------------------------------------

-- After creating the admin user under Authentication > Users, add their
-- email (lowercase) here and run just this statement:
--
-- insert into public.admins (email) values ('admin@example.com')
-- on conflict do nothing;
