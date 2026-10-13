// Public settings for the website. Nothing secret belongs here: the publishable key is meant to be seen by every visitor
// (what each person may read or change is decided by the database's row-level security, supabase/schema.sql).
// For the real launch, make a new Supabase project and replace the two values.
export const SUPABASE_URL = 'https://djxnoijgwtklszvgunma.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_F2OsiXcNMGmQBVgPjAUE4Q_09LXCxjB';
// Shown to the owner's screens only as a hint; the database checks the real role (profiles.role = 'owner').
export const OWNER_EMAIL = 'surshan@gmail.com';
