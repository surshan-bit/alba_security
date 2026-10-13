-- Alba Securities: database for Supabase (run once in the Supabase SQL editor). UNVERIFIED until run on a real project.
-- One table holds every document the app keeps, addressed by path ('data/users/<uid>/prefs', 'stockMeta/main', ...).

create table if not exists public.docs (
  path       text primary key,
  parent     text generated always as (regexp_replace(path, '/[^/]*$', '')) stored,
  id         text generated always as (regexp_replace(path, '^.*/', '')) stored,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists docs_parent_idx on public.docs (parent, id);
create index if not exists docs_ticker_idx on public.docs ((data->>'ticker')) where parent = 'priceHistory';

-- who may do what: plan and trial live here, written only by the server (payment webhook) or the owner
create table if not exists public.profiles (
  uid         uuid primary key references auth.users on delete cascade,
  email       text not null,
  role        text not null default 'user' check (role in ('user','owner')),
  plan        text not null default 'trial' check (plan in ('trial','free','pro')),
  trial_end   timestamptz not null default (now() + interval '15 days'),
  pro_until   timestamptz,
  created_at  timestamptz not null default now()
);

-- a profile appears at the first Google sign-in; the 15-day trial starts then
create or replace function public.on_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (uid, email) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.on_new_user();

create or replace function public.is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where uid = auth.uid() and role = 'owner');
$$;
create or replace function public.has_pro() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where uid = auth.uid()
    and (role = 'owner' or (plan = 'pro' and pro_until > now()) or (plan = 'trial' and trial_end > now())));
$$;

-- merge a partial update into a document (what update() means)
create or replace function public.docs_merge(p_path text, p_data jsonb) returns void language plpgsql security invoker as $$
begin
  insert into public.docs (path, data) values (p_path, p_data)
  on conflict (path) do update set data = public.docs.data || excluded.data, updated_at = now();
end $$;

alter table public.docs enable row level security;
alter table public.profiles enable row level security;

-- your own documents: data/users/<your uid>/...
create policy own_docs_all on public.docs for all to authenticated
  using (path like 'data/users/' || auth.uid()::text || '/%')
  with check (path like 'data/users/' || auth.uid()::text || '/%');

-- shared stock data: everyone signed in may read the free part; Pro / trial users and the owner read all; only the owner writes
create policy shared_read_free on public.docs for select to authenticated
  using (path like 'stockMeta/%' or path like 'stockUpdates/%');
create policy shared_read_pro on public.docs for select to authenticated
  using ((path like 'stockData/%' or path like 'stockResearch/%' or path like 'priceHistory/%') and public.has_pro());
create policy shared_write_owner on public.docs for all to authenticated
  using (public.is_owner() and path not like 'data/users/%') with check (public.is_owner() and path not like 'data/users/%');

create policy own_user_record on public.docs for all to authenticated
  using (path = 'users/' || auth.uid()::text) with check (path = 'users/' || auth.uid()::text);
create policy owner_read_users on public.docs for select to authenticated
  using (public.is_owner() and path like 'users/%');

create policy profile_read_own on public.profiles for select to authenticated using (uid = auth.uid());
-- no insert / update policy: profiles change only through the trigger above, the payment webhook (service key) or the owner in the dashboard.

-- file storage: a private-by-folder bucket for uploads
insert into storage.buckets (id, name, public) values ('assets', 'assets', true) on conflict do nothing;
create policy assets_own on storage.objects for all to authenticated
  using (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'assets' and (storage.foldername(name))[1] = auth.uid()::text);

-- tables are not exposed automatically (a project setting), so access is granted here, on purpose.
-- Row level security above still decides which rows each person may see or change.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.docs to authenticated;
grant select on public.profiles to authenticated;
grant execute on function public.docs_merge(text, jsonb) to authenticated;
revoke all on public.docs, public.profiles from anon;

alter publication supabase_realtime add table public.docs;
