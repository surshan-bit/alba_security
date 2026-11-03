-- Run in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql). Safe to run again.
-- A signed-in user can no longer store a document bigger than 1 MiB of JSON under their own paths (data/users/<uid>/... and users/<uid>).
-- Documents already stored are kept; only a write that makes a document bigger than the limit is refused. The owner's shared stock data is not capped.
-- the most a signed-in user may store in one document (1 MiB of JSON text); the app's largest documents are a small fraction of this
create or replace function public.doc_size_ok(d jsonb) returns boolean language sql immutable set search_path = '' as $$
  select octet_length(d::text) <= 1048576;
$$;

drop policy if exists own_docs_all on public.docs;
create policy own_docs_all on public.docs for all to authenticated
  using (path like 'data/users/' || auth.uid()::text || '/%')
  with check (path like 'data/users/' || auth.uid()::text || '/%' and public.doc_size_ok(data));

drop policy if exists own_user_record on public.docs;
create policy own_user_record on public.docs for all to authenticated
  using (path = 'users/' || auth.uid()::text) with check (path = 'users/' || auth.uid()::text and public.doc_size_ok(data));
