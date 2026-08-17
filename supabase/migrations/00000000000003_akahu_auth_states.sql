-- Single-use, expiring `state` values for the Akahu authorisation flow.
--
-- `state` binds an authorisation attempt to the user who started it. Without
-- it, anyone holding a valid authorisation code could have it exchanged against
-- someone else's account, which would attach a stranger's bank to your login.
--
-- Three properties, all enforced here rather than hoped for:
--
--   bound      user_id is captured when the flow starts, from a verified JWT
--   expiring   expires_at is checked on use; abandoned attempts age out
--   single-use consumed_at is set on first use and refuses every use after
--
-- RLS is enabled with **no policies**, like akahu_tokens and apple_grants. A
-- state value is a capability: whoever holds it can complete a connection, so
-- no user client has any business reading the table. Only the service role
-- touches it.

create table public.akahu_auth_states (
  -- High-entropy random value; also the primary key, so a duplicate insert is
  -- a collision rather than an overwrite.
  state       text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

create index akahu_auth_states_user_id_idx on public.akahu_auth_states (user_id);
create index akahu_auth_states_expires_at_idx on public.akahu_auth_states (expires_at);

alter table public.akahu_auth_states enable row level security;

-- `grant ... on all tables in schema public` in the initial migration was a
-- SNAPSHOT of the tables existing at that moment, not a standing rule. Every
-- table created afterwards starts with no privileges for service_role and is
-- unreachable until granted here — with RLS enabled and no policies, the
-- symptom is `42501 permission denied`, which reads like an RLS problem and is
-- not one.
--
-- Grant service_role only. No grant to `anon` or `authenticated`, matching the
-- absent policies: this table is a capability store, not user data.
grant select, insert, update, delete on public.akahu_auth_states to service_role;

comment on table public.akahu_auth_states is
  'Single-use expiring state for the Akahu authorisation flow. RLS enabled with no policies on purpose: a state value is a capability, not user data.';

comment on column public.akahu_auth_states.consumed_at is
  'Set on first use. A second exchange with the same state is refused, so a replayed redirect cannot connect a bank twice.';
