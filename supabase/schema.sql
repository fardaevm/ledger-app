-- Ledger app schema — run this once in your Supabase project's SQL editor
-- (Project > SQL Editor > New query > paste this whole file > Run)

create extension if not exists pgcrypto;

-- one row per household (in practice: one row for you and your partner)
create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our household',
  invite_code text unique not null default substr(md5(random()::text), 1, 8),
  created_by uuid references auth.users(id) not null,
  created_at timestamptz not null default now()
);

-- who belongs to which household
create table household_members (
  household_id uuid references households(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- the actual ledger entries
create table transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric not null check (amount > 0),
  date date not null,
  category text not null,
  note text not null default '',
  author_id uuid references auth.users(id) not null,
  author_email text not null,
  created_at timestamptz not null default now()
);

create index transactions_household_date_idx on transactions (household_id, date desc);

alter table households enable row level security;
alter table household_members enable row level security;
alter table transactions enable row level security;

-- HOUSEHOLDS -------------------------------------------------------------
create policy "members read own household"
  on households for select
  using (id in (select household_id from household_members where user_id = auth.uid()));

create policy "creator can insert their household"
  on households for insert
  with check (created_by = auth.uid());

-- HOUSEHOLD MEMBERS --------------------------------------------------------
create policy "members read own roster"
  on household_members for select
  using (household_id in (select household_id from household_members where user_id = auth.uid()));

create policy "users add only their own membership row"
  on household_members for insert
  with check (user_id = auth.uid());

-- TRANSACTIONS -------------------------------------------------------------
create policy "members read household transactions"
  on transactions for select
  using (household_id in (select household_id from household_members where user_id = auth.uid()));

create policy "members insert household transactions"
  on transactions for insert
  with check (
    author_id = auth.uid()
    and household_id in (select household_id from household_members where user_id = auth.uid())
  );

create policy "authors delete their own transactions"
  on transactions for delete
  using (author_id = auth.uid());

-- RPCs ----------------------------------------------------------------------
-- These run as the function owner (bypasses RLS internally), which is what
-- lets "join by code" work without exposing every household to every user.

create or replace function create_household(hname text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hh_id uuid;
begin
  insert into households (name, created_by)
  values (coalesce(nullif(trim(hname), ''), 'Our household'), auth.uid())
  returning id into hh_id;

  insert into household_members (household_id, user_id, role)
  values (hh_id, auth.uid(), 'owner');

  return hh_id;
end;
$$;

create or replace function join_household(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hh_id uuid;
begin
  select id into hh_id from households where invite_code = lower(trim(code));
  if hh_id is null then
    raise exception 'invalid_code';
  end if;

  insert into household_members (household_id, user_id, role)
  values (hh_id, auth.uid(), 'member')
  on conflict do nothing;

  return hh_id;
end;
$$;

-- REALTIME --------------------------------------------------------------
alter publication supabase_realtime add table transactions;

-- MIGRATION 2026-09-26: profit goal ----------------------------------------
-- Existing projects: run just this block in the SQL editor. Safe to re-run.

-- Custom monthly profit goal; null = automatic (default or average of prior periods).
alter table households
  add column if not exists profit_goal_override numeric
  check (profit_goal_override is null or profit_goal_override > 0);

drop policy if exists "members update own household" on households;
create policy "members update own household"
  on households for update
  using (id in (select household_id from household_members where user_id = auth.uid()))
  with check (id in (select household_id from household_members where user_id = auth.uid()));

-- The policy decides WHICH rows members can update; these grants limit WHAT they can
-- change, so name, invite_code and created_by stay read-only from the client.
revoke update on households from anon, authenticated;
grant update (profit_goal_override) on households to authenticated;

-- MIGRATION 2026-09-26b: password auth, profiles, invite links -----------------
-- Existing projects: run just this block in the SQL editor. Safe to re-run.
--
-- It only ADDS tables/functions and REPLACES access rules. It does not update or
-- delete any row in households, household_members or transactions, and it does not
-- touch auth.users (passwords are set by users themselves via the reset-password email).

-- Helper for RLS: the caller's household ids. SECURITY DEFINER so a policy on
-- household_members can use it without re-entering its own policy (which Postgres
-- rejects as "infinite recursion detected in policy").
create or replace function my_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select household_id from household_members where user_id = auth.uid()
$$;
revoke execute on function my_household_ids() from public, anon;
grant execute on function my_household_ids() to authenticated;

drop policy if exists "members read own roster" on household_members;
create policy "members read own roster"
  on household_members for select
  using (household_id in (select my_household_ids()));

-- Joining a household is now ONLY possible through redeem_invite() (or creating your
-- own via create_household()). The old policy let any signed-in user insert a
-- membership row for any household id, bypassing invites entirely.
drop policy if exists "users add only their own membership row" on household_members;

-- One household per person: calling create_household again returns the existing one
-- instead of creating a second (e.g. a double-tapped "Create household" button).
create or replace function create_household(hname text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  hh_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  select household_id into hh_id from household_members where user_id = auth.uid() limit 1;
  if hh_id is not null then
    return hh_id;
  end if;

  insert into households (name, created_by)
  values (coalesce(nullif(left(btrim(hname), 60), ''), 'Our household'), auth.uid())
  returning id into hh_id;

  insert into household_members (household_id, user_id, role)
  values (hh_id, auth.uid(), 'owner');

  return hh_id;
end;
$$;
revoke execute on function create_household(text) from public, anon;
grant execute on function create_household(text) to authenticated;

-- PROFILES -----------------------------------------------------------------------
-- Display names, collected on the sign-up form and copied here by a trigger (the
-- new user has no session until they confirm their email, so the client can't write
-- this row itself).
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;

drop policy if exists "read own and housemates' profiles" on profiles;
create policy "read own and housemates' profiles"
  on profiles for select
  using (
    id = auth.uid()
    or id in (select user_id from household_members where household_id in (select my_household_ids()))
  );

drop policy if exists "update own profile" on profiles;
create policy "update own profile"
  on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Rows are only ever created by the trigger; clients may change their own name only.
revoke insert, update, delete on profiles from anon, authenticated;
grant update (display_name) on profiles to authenticated;

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 60), ''),
      nullif(split_part(new.email, '@', 1), ''),
      'Member'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill for accounts that existed before this migration (created via magic link,
-- so no display name was ever collected): use the part of the email before the @.
-- They can be renamed with: update profiles set display_name = '…' where id = '…';
insert into profiles (id, display_name)
select
  u.id,
  coalesce(
    nullif(left(btrim(u.raw_user_meta_data ->> 'display_name'), 60), ''),
    nullif(split_part(u.email, '@', 1), ''),
    'Member'
  )
from auth.users u
on conflict (id) do nothing;

-- INVITES ------------------------------------------------------------------------
-- A shareable link carries a 256-bit random token. Only its SHA-256 hash is stored,
-- so a database leak or an over-broad SELECT can't reveal usable invite links.
create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  token_hash bytea not null unique,
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  used_by uuid references auth.users(id) on delete set null
);
alter table invites enable row level security;

-- Members can see (metadata only) and revoke their own household's unused invites.
-- There is deliberately no INSERT/UPDATE policy: invites are created by create_invite()
-- and consumed by redeem_invite(), never written directly.
drop policy if exists "members read household invites" on invites;
create policy "members read household invites"
  on invites for select
  using (household_id in (select my_household_ids()));

drop policy if exists "members revoke unused household invites" on invites;
create policy "members revoke unused household invites"
  on invites for delete
  using (household_id in (select my_household_ids()) and used_at is null);

revoke insert, update on invites from anon, authenticated;

-- Returns the raw token exactly once; it is never stored or retrievable again.
create or replace function create_invite(hid uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  raw_token text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from household_members where household_id = hid and user_id = auth.uid()) then
    raise exception 'not_a_member';
  end if;
  if (select count(*) from invites
      where household_id = hid and used_at is null and expires_at > now()) >= 10 then
    raise exception 'too_many_invites';
  end if;

  raw_token := encode(gen_random_bytes(32), 'hex');
  insert into invites (household_id, token_hash, invited_by)
  values (hid, digest(raw_token, 'sha256'), auth.uid());
  return raw_token;
end;
$$;
revoke execute on function create_invite(uuid) from public, anon;
grant execute on function create_invite(uuid) to authenticated;

-- Validates and consumes an invite, then adds the caller to the household.
-- Errors (all raised, so the client gets a clear reason):
--   invalid_invite, invite_used, invite_expired, already_in_household, not_authenticated
create or replace function redeem_invite(raw_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  inv invites%rowtype;
  current_hh uuid;
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if raw_token is null or raw_token !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_invite';
  end if;

  -- FOR UPDATE: two people redeeming the same link at once can't both succeed.
  select * into inv from invites where token_hash = digest(raw_token, 'sha256') for update;
  if not found then
    raise exception 'invalid_invite';
  end if;

  -- Re-opening a link you already used is a no-op, not an error.
  if exists (select 1 from household_members where household_id = inv.household_id and user_id = uid) then
    return inv.household_id;
  end if;
  if inv.used_at is not null then
    raise exception 'invite_used';
  end if;
  if inv.expires_at <= now() then
    raise exception 'invite_expired';
  end if;

  -- The app is one-household-per-person. An empty solo household (e.g. created by
  -- someone who signed up before opening the link) is discarded; one with any
  -- transactions or other members is never touched.
  select household_id into current_hh from household_members where user_id = uid limit 1;
  if current_hh is not null then
    if exists (select 1 from transactions where household_id = current_hh)
       or exists (select 1 from household_members where household_id = current_hh and user_id <> uid) then
      raise exception 'already_in_household';
    end if;
    delete from households where id = current_hh;
  end if;

  insert into household_members (household_id, user_id, role)
  values (inv.household_id, uid, 'member');
  update invites set used_at = now(), used_by = uid where id = inv.id;
  return inv.household_id;
end;
$$;
revoke execute on function redeem_invite(text) from public, anon;
grant execute on function redeem_invite(text) to authenticated;

-- PHASE 2 — retire the old typed invite codes --------------------------------------
-- Run ONLY after both existing members have set a password, signed in, and seen their
-- household and transactions under the new flow. (Fresh projects: run it right away.)
-- Until then, join_household() remains callable with the old 8-character code — a
-- short, guessable secret — so don't leave this step for long.
--
-- drop function if exists join_household(text);
-- alter table households drop column if exists invite_code;
