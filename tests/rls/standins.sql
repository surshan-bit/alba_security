-- The small parts of Supabase that supabase/schema.sql relies on, so the schema can run on a plain PostgreSQL server for the tests.
-- Same names and shapes as the real ones; nothing here is part of the product.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
end $$;

create schema auth;
create table auth.users (id uuid primary key, email text);
-- the signed-in user, as set by the test for each query (Supabase reads it from the request's token)
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid', true), '')::uuid $$;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (bucket_id text, name text);
create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;

create publication supabase_realtime;

grant usage on schema auth, storage to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;

-- Supabase can give the anonymous role access to every new table by default (a project setting). Model that, so the schema's own
-- `revoke ... from anon` is what keeps docs and profiles closed, and the tests notice if it goes.
alter default privileges in schema public grant all on tables to anon;
