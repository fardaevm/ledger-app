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

-- MIGRATION 2026-09-27: grouped category names ------------------------------------
-- Moves existing transactions from the old flat category names to the new grouped
-- list (see CATEGORIES in src/main.js). Only rows still using an old name change;
-- safe to re-run. Changes nothing but the category text.
--
-- Preview first (read-only) — how many entries each rename will touch:
--   select type, category, count(*) from transactions
--   where (type, category) in (
--     ('expense','Rent & Housing'), ('expense','Transport'), ('expense','Utilities'),
--     ('expense','Subscriptions'), ('expense','Dining & Entertainment'),
--     ('expense','Health & Fitness'), ('expense','Software & Tools'),
--     ('income','Investment'), ('income','Gifts'))
--   group by 1, 2 order by 1, 2;
update transactions t
set category = m.new_name
from (values
  ('expense', 'Rent & Housing',         'Rent / Mortgage'),
  ('expense', 'Transport',              'Other transportation'),
  ('expense', 'Utilities',              'Other bills'),
  ('expense', 'Subscriptions',          'Subscriptions & streaming'),
  ('expense', 'Dining & Entertainment', 'Restaurants & takeout'),
  ('expense', 'Health & Fitness',       'Other health'),
  ('expense', 'Software & Tools',       'Software & tools'),
  ('income',  'Investment',             'Investments & interest'),
  ('income',  'Gifts',                  'Gifts received')
) as m(type, old_name, new_name)
where t.type = m.type and t.category = m.old_name;

-- MIGRATION 2026-09-27b: recurring rules and debts ---------------------------------
-- Existing projects: run just this block in the SQL editor. Safe to re-run.
-- Adds two tables and two nullable columns on transactions; changes no existing row.

create table if not exists recurring_rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric not null check (amount > 0),
  category text not null,
  note text not null default '',
  day_of_month int not null check (day_of_month between 1 and 28),
  active boolean not null default true,
  created_by uuid references auth.users(id) not null,
  created_at timestamptz not null default now(),
  -- First day of the last month this rule was handled (an entry created, or deliberately
  -- skipped). Stops a deleted auto-entry from being re-created on the next app load.
  last_materialized_month date
);

create table if not exists debts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  debt_type text not null check (debt_type in ('credit_card', 'loan', 'mortgage', 'other')),
  original_balance numeric not null check (original_balance > 0),
  current_balance numeric not null check (current_balance >= 0),
  interest_rate numeric check (interest_rate is null or interest_rate between 0 and 100),
  minimum_payment numeric check (minimum_payment is null or minimum_payment > 0),
  created_by uuid references auth.users(id) not null,
  created_at timestamptz not null default now()
);

-- Links from a transaction to the rule or debt that produced it. Normal entries leave both null.
alter table transactions add column if not exists recurring_rule_id uuid references recurring_rules(id) on delete set null;
alter table transactions add column if not exists debt_id uuid references debts(id) on delete set null;

-- At most one auto-entry per rule per date, even if both partners open the app at once.
-- (NULLs never conflict, so ordinary transactions are unaffected.)
do $$ begin
  alter table transactions add constraint transactions_recurring_once unique (recurring_rule_id, date);
exception when duplicate_object or duplicate_table then null;
end $$;

-- The app may not set recurring_rule_id / debt_id itself: only materialize_recurring() and
-- log_debt_payment() do. Otherwise any user could plant an entry pointing at another
-- household's rule and block that household's auto-entry via the constraint above.
revoke insert on transactions from anon, authenticated;
grant insert (id, household_id, type, amount, date, category, note, author_id, author_email, created_at)
  on transactions to authenticated;

alter table recurring_rules enable row level security;
alter table debts enable row level security;

-- Same pattern as transactions: members read and add; only the creator changes or removes.
drop policy if exists "members read household recurring rules" on recurring_rules;
create policy "members read household recurring rules"
  on recurring_rules for select using (household_id in (select my_household_ids()));
drop policy if exists "members add recurring rules" on recurring_rules;
create policy "members add recurring rules"
  on recurring_rules for insert
  with check (created_by = auth.uid() and household_id in (select my_household_ids()));
drop policy if exists "creators update their recurring rules" on recurring_rules;
create policy "creators update their recurring rules"
  on recurring_rules for update
  using (created_by = auth.uid() and household_id in (select my_household_ids()))
  with check (created_by = auth.uid() and household_id in (select my_household_ids()));
drop policy if exists "creators delete their recurring rules" on recurring_rules;
create policy "creators delete their recurring rules"
  on recurring_rules for delete using (created_by = auth.uid());

drop policy if exists "members read household debts" on debts;
create policy "members read household debts"
  on debts for select using (household_id in (select my_household_ids()));
drop policy if exists "members add debts" on debts;
create policy "members add debts"
  on debts for insert
  with check (created_by = auth.uid() and household_id in (select my_household_ids()));
drop policy if exists "creators update their debts" on debts;
create policy "creators update their debts"
  on debts for update
  using (created_by = auth.uid() and household_id in (select my_household_ids()))
  with check (created_by = auth.uid() and household_id in (select my_household_ids()));
drop policy if exists "creators delete their debts" on debts;
create policy "creators delete their debts"
  on debts for delete using (created_by = auth.uid());

-- Creates this month's entry for every active rule whose day has arrived and that hasn't been
-- handled this month. Runs in one transaction with row locks, so concurrent calls from two
-- devices can't double-insert. Returns how many entries it created.
-- `today` is the caller's local date (month boundaries are the household's, not UTC's);
-- anything more than a day away from the server's date is ignored.
create or replace function materialize_recurring(hid uuid, today date default current_date)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  month_start date;
  created integer := 0;
  rows_in integer;
  r recurring_rules%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from household_members where household_id = hid and user_id = auth.uid()) then
    raise exception 'not_a_member';
  end if;
  if today is null or abs(today - current_date) > 1 then
    today := current_date;
  end if;
  month_start := date_trunc('month', today)::date;

  for r in
    select * from recurring_rules
    where household_id = hid
      and active
      and day_of_month <= extract(day from today)
      and (last_materialized_month is null or last_materialized_month < month_start)
    for update
  loop
    insert into transactions (household_id, type, amount, date, category, note, author_id, author_email, recurring_rule_id)
    select r.household_id, r.type, r.amount, month_start + (r.day_of_month - 1), r.category, r.note,
           r.created_by, u.email, r.id
    from auth.users u where u.id = r.created_by
    on conflict (recurring_rule_id, date) do nothing;
    get diagnostics rows_in = row_count;
    created := created + rows_in;
    update recurring_rules set last_materialized_month = month_start where id = r.id;
  end loop;
  return created;
end;
$$;
revoke execute on function materialize_recurring(uuid, date) from public, anon;
grant execute on function materialize_recurring(uuid, date) to authenticated;

-- One action, two consistent effects: lowers the debt's balance AND records the matching
-- expense, atomically. Any household member may log a payment on any household debt.
create or replace function log_debt_payment(target_debt uuid, pay_amount numeric, paid_on date default current_date)
returns numeric
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  d debts%rowtype;
  uid uuid := auth.uid();
  new_balance numeric;
begin
  if uid is null then
    raise exception 'not_authenticated';
  end if;
  if pay_amount is null or pay_amount <= 0 then
    raise exception 'invalid_amount';
  end if;
  select * into d from debts where id = target_debt for update;
  if not found or not exists (select 1 from household_members where household_id = d.household_id and user_id = uid) then
    raise exception 'debt_not_found';
  end if;
  if pay_amount > d.current_balance then
    raise exception 'more_than_balance';
  end if;
  if paid_on is null or paid_on > current_date + 1 then
    paid_on := current_date;
  end if;

  update debts set current_balance = current_balance - pay_amount where id = d.id
  returning current_balance into new_balance;

  insert into transactions (household_id, type, amount, date, category, note, author_id, author_email, debt_id)
  select d.household_id, 'expense', pay_amount, paid_on, 'Loan & card payments', left('Payment: ' || d.name, 200), uid, u.email, d.id
  from auth.users u where u.id = uid;

  return new_balance;
end;
$$;
revoke execute on function log_debt_payment(uuid, numeric, date) from public, anon;
grant execute on function log_debt_payment(uuid, numeric, date) to authenticated;

-- Deleting a payment's expense entry puts the amount back on the debt, so the two never drift.
create or replace function restore_debt_on_payment_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.debt_id is not null and old.type = 'expense' then
    update debts set current_balance = current_balance + old.amount where id = old.debt_id;
  end if;
  return old;
end;
$$;
revoke execute on function restore_debt_on_payment_delete() from public, anon, authenticated;

drop trigger if exists restore_debt_on_payment_delete on transactions;
create trigger restore_debt_on_payment_delete
  after delete on transactions
  for each row execute function restore_debt_on_payment_delete();

-- MIGRATION 2026-09-28: Members page roster ------------------------------------------
-- Existing projects: run just this block in the SQL editor. Safe to re-run. Adds one
-- read-only function; changes no table or row.
-- Emails live in auth.users, which the app can't read. This returns name, email and join date
-- for the members of ONE household, and only to someone who belongs to it.
create or replace function household_roster(hid uuid)
returns table (user_id uuid, display_name text, email text, role text, joined_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.user_id, p.display_name, u.email::text, m.role, m.joined_at
  from household_members m
  join auth.users u on u.id = m.user_id
  left join profiles p on p.id = m.user_id
  where m.household_id = hid
    and exists (select 1 from household_members me where me.household_id = hid and me.user_id = auth.uid())
  order by m.joined_at;
$$;
revoke execute on function household_roster(uuid) from public, anon;
grant execute on function household_roster(uuid) to authenticated;

-- MIGRATION 2026-09-28b: category usage counts (for the add-transaction chips) -----------
-- Existing projects: run just this block in the SQL editor. Safe to re-run. Adds one
-- read-only function; changes no table or row.
-- How often each category has been used, per type, across the household's whole history
-- (the app itself only loads the newest 1,000 entries). SECURITY INVOKER: it runs as the
-- caller, so the transactions read policy decides what's counted: only your own household.
create or replace function category_usage(hid uuid)
returns table (type text, category text, uses bigint)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select t.type, t.category, count(*) as uses
  from transactions t
  where t.household_id = hid
  group by t.type, t.category;
$$;
revoke execute on function category_usage(uuid) from public, anon;
grant execute on function category_usage(uuid) to authenticated;

-- MIGRATION 2026-09-29: Plaid bank connections (Sandbox) ------------------------------
-- Existing projects: run just this block in the SQL editor. Safe to re-run. Adds two tables
-- and two columns on transactions; every existing entry becomes source 'manual'.
-- Written only by the server (/api/plaid/*), which queries with the caller's own JWT, so
-- these policies are what keeps one household out of another's bank data.

-- One row per linked bank login ("Item" in Plaid's terms). access_token is Fernet-encrypted
-- by the server (PLAID_TOKEN_ENCRYPTION_KEY, which only the server has) before it gets here:
-- members can read the row, but the ciphertext is useless without that key.
create table if not exists plaid_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade not null,
  access_token text not null,
  item_id text not null unique,
  institution_name text,
  cursor text,  -- /transactions/sync position; null = never synced
  linked_by uuid references auth.users(id) not null,
  created_at timestamptz not null default now()
);

-- Where a transaction came from. The app's own inserts can't set either column (see the
-- column grant in 2026-09-27b), so manual entries are always 'manual'; only a server-side
-- import from the review queue will write 'plaid'.
alter table transactions add column if not exists plaid_transaction_id text;
alter table transactions add column if not exists source text not null default 'manual';
do $$ begin
  alter table transactions add constraint transactions_plaid_transaction_id_key unique (plaid_transaction_id);
exception when duplicate_object or duplicate_table then null;
end $$;
do $$ begin
  alter table transactions add constraint transactions_source_check check (source in ('manual', 'plaid'));
exception when duplicate_object then null;
end $$;

-- Synced bank transactions wait here until someone reviews them; nothing goes straight into
-- the ledger. One row per bank transaction per household (sync upserts on this pair).
create table if not exists plaid_review_queue (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete cascade not null,
  plaid_transaction_id text not null,
  suggested_category text not null default 'Other',
  amount numeric not null check (amount > 0),
  date date not null,
  merchant_name text,
  type text not null check (type in ('income', 'expense')),
  raw_plaid_data jsonb,  -- the transaction as Plaid sent it, for debugging the mapping
  reviewed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (household_id, plaid_transaction_id)
);
create index if not exists plaid_review_queue_pending_idx on plaid_review_queue (household_id, reviewed, date desc);

alter table plaid_items enable row level security;
alter table plaid_review_queue enable row level security;

-- Items: the same pattern as debts (members read and add; the linker removes), except that
-- ANY member may advance the sync cursor, since either partner can press sync. The column
-- grant limits updates to the cursor: the token, item and owner are fixed once linked.
drop policy if exists "members read household plaid items" on plaid_items;
create policy "members read household plaid items"
  on plaid_items for select using (household_id in (select my_household_ids()));
drop policy if exists "members link plaid items" on plaid_items;
create policy "members link plaid items"
  on plaid_items for insert
  with check (linked_by = auth.uid() and household_id in (select my_household_ids()));
drop policy if exists "members advance the plaid cursor" on plaid_items;
create policy "members advance the plaid cursor"
  on plaid_items for update
  using (household_id in (select my_household_ids()))
  with check (household_id in (select my_household_ids()));
drop policy if exists "linkers unlink their plaid items" on plaid_items;
create policy "linkers unlink their plaid items"
  on plaid_items for delete using (linked_by = auth.uid());
revoke update on plaid_items from anon, authenticated;
grant update (cursor) on plaid_items to authenticated;

-- Review queue: any member reads, adds (via sync), marks reviewed and clears.
drop policy if exists "members read household review queue" on plaid_review_queue;
create policy "members read household review queue"
  on plaid_review_queue for select using (household_id in (select my_household_ids()));
drop policy if exists "members add to household review queue" on plaid_review_queue;
create policy "members add to household review queue"
  on plaid_review_queue for insert with check (household_id in (select my_household_ids()));
drop policy if exists "members update household review queue" on plaid_review_queue;
create policy "members update household review queue"
  on plaid_review_queue for update
  using (household_id in (select my_household_ids()))
  with check (household_id in (select my_household_ids()));
drop policy if exists "members clear household review queue" on plaid_review_queue;
create policy "members clear household review queue"
  on plaid_review_queue for delete using (household_id in (select my_household_ids()));
