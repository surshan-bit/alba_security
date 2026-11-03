-- Run once in the Supabase SQL editor on a project created before this change (new projects get it from schema.sql).
-- The file bucket accepts only CSV text (what the fundamental import uploads) up to 10 MiB per file. Files already in the bucket are kept.
update storage.buckets set file_size_limit = 10485760, allowed_mime_types = array['text/csv'] where id = 'assets';
