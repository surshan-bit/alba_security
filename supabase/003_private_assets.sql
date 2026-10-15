-- Run once in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql).
-- Makes the file bucket private. Uploaded files (CSV uploads and full backups of the stock list) stop being readable by anyone who
-- has a link; the signed-in owner still reads and writes their own folder through the app (policy assets_own in schema.sql).
update storage.buckets set public = false where id = 'assets';
