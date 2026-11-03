-- Run once in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql).
-- RUN THIS BEFORE the Claude function (supabase/functions/sample) is deployed with this change: until it exists, every call is refused.
-- Lets the Claude function count the owner's calls and refuse them once the limit for the window is used up.
create table if not exists public.sample_usage (
  uid          uuid primary key references auth.users on delete cascade,
  window_start timestamptz not null default now(),
  calls        integer not null default 0
);
-- no policy and no grant: clients never touch this table, only take_sample_slot below does
alter table public.sample_usage enable row level security;

-- counts one Claude call for the owner and says whether it is inside the limit (a fixed window that restarts when it has run out)
create or replace function public.take_sample_slot(p_limit integer, p_window interval) returns boolean
  language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  if not public.is_owner() then return false; end if;
  insert into public.sample_usage as u (uid, window_start, calls) values (auth.uid(), now(), 1)
  on conflict (uid) do update set
    window_start = case when u.window_start <= now() - p_window then now() else u.window_start end,
    calls        = case when u.window_start <= now() - p_window then 1 else u.calls + 1 end
  returning u.calls into used;
  return used <= p_limit;
end $$;
revoke all on function public.take_sample_slot(integer, interval) from public, anon;
grant execute on function public.take_sample_slot(integer, interval) to authenticated;
