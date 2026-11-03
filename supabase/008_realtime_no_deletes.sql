-- Run in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql). Safe to run again.
-- Realtime sends inserts and updates only. A delete event is not filtered by row-level security, so it would reach every signed-in user with the
-- path of the deleted document (a trade's path carries its symbol and date). A deletion made on one device then shows on the others after a reload.
-- The setting covers the whole publication, so it is applied only when docs is the only table in it.
do $$ begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and not (schemaname = 'public' and tablename = 'docs')) then
    alter publication supabase_realtime set (publish = 'insert, update');
  else
    raise warning 'supabase_realtime does not publish docs alone, so delete events were NOT turned off: stop them another way, with a separate publication or private channels';
  end if;
end $$;
