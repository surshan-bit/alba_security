-- Run once in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql).
-- The three security-definer functions get an empty search path (their bodies already name every table with its schema), and they stop
-- being callable by the public or anon. Signed-in users keep is_owner / has_pro, which the row-level rules call.
create or replace function public.on_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (uid, email) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;

create or replace function public.is_owner() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where uid = auth.uid() and role = 'owner');
$$;
create or replace function public.has_pro() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where uid = auth.uid()
    and (role = 'owner' or (plan = 'pro' and pro_until > now()) or (plan = 'trial' and trial_end > now())));
$$;

-- definer functions run with the owner's rights, so they get an empty search path and are not open to the public; only signed-in users
-- need is_owner / has_pro (the row-level rules below call them), and the sign-up trigger needs no caller at all
revoke all on function public.on_new_user() from public, anon;
revoke all on function public.is_owner() from public, anon;
revoke all on function public.has_pro() from public, anon;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.has_pro() to authenticated;
