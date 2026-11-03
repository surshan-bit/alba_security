-- Run in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql). Safe to run again.
-- A signed-in user can keep at most 10000 documents under data/users/<their uid>/. Documents already stored are kept and counted; a user above
-- the limit can still delete and rewrite, but not add. The single users/<uid> record and the owner's shared stock data are not counted.
-- Row limit: a signed-in user keeps at most doc_row_limit() documents under data/users/<their uid>/ (the size of each is capped by doc_size_ok).
-- A counter per user is kept by triggers. They run AFTER the insert, so an upsert that only rewrites an existing document is not counted again.
create or replace function public.doc_row_limit() returns integer language sql immutable set search_path = '' as $$
  select 10000;
$$;
-- whose private documents a path belongs to (data/users/<uid>/...), or null for any other path
create or replace function public.doc_owner(p_path text) returns uuid language sql immutable set search_path = '' as $$
  select (regexp_match(p_path, '^data/users/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/'))[1]::uuid;
$$;
create table if not exists public.doc_counts (
  uid uuid primary key,
  n   integer not null default 0
);
-- no policy and no grant: clients never touch this table, only the triggers below do
alter table public.doc_counts enable row level security;
revoke all on public.doc_counts from anon;

create or replace function public.count_doc_insert() returns trigger language plpgsql security definer set search_path = '' as $$
declare owner uuid := public.doc_owner(new.path); used integer;
begin
  if owner is null then return null; end if;
  insert into public.doc_counts as c (uid, n) values (owner, 1) on conflict (uid) do update set n = c.n + 1 returning c.n into used;
  if used > public.doc_row_limit() then
    raise exception 'You have reached the limit of % documents.', public.doc_row_limit() using errcode = '54000';
  end if;
  return null;
end $$;
create or replace function public.count_doc_delete() returns trigger language plpgsql security definer set search_path = '' as $$
declare owner uuid := public.doc_owner(old.path);
begin
  if owner is not null then update public.doc_counts as c set n = greatest(c.n - 1, 0) where c.uid = owner; end if;
  return null;
end $$;
revoke all on function public.count_doc_insert() from public, anon;
revoke all on function public.count_doc_delete() from public, anon;
drop trigger if exists docs_count_insert on public.docs;
create trigger docs_count_insert after insert on public.docs for each row execute function public.count_doc_insert();
drop trigger if exists docs_count_delete on public.docs;
create trigger docs_count_delete after delete on public.docs for each row execute function public.count_doc_delete();

-- count what is already stored (also repairs the counters if they ever drift)
insert into public.doc_counts (uid, n) select public.doc_owner(path), count(*) from public.docs where public.doc_owner(path) is not null group by 1
  on conflict (uid) do update set n = excluded.n;
update public.doc_counts set n = 0 where uid not in (select public.doc_owner(path) from public.docs where public.doc_owner(path) is not null);
