-- Run once in the Supabase SQL editor (already included in schema.sql for new projects).
-- The app keeps a small record per person at users/<uid>: each person writes their own, the owner can read all.
create policy own_user_record on public.docs for all to authenticated
  using (path = 'users/' || auth.uid()::text) with check (path = 'users/' || auth.uid()::text);
create policy owner_read_users on public.docs for select to authenticated
  using (public.is_owner() and path like 'users/%');
