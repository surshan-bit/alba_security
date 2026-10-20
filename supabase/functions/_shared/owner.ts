// Shared by the private functions: lets only the owner account through. The caller's own sign-in token is used, so the
// database's row-level rules decide (profiles.role = 'owner'); nothing here trusts what the browser says about itself.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.117.3';
import { corsHeaders } from './cors.ts';

export const cors = (req: Request) => corsHeaders(req.headers.get('Origin'), Deno.env.get('ALLOWED_ORIGINS'));
export const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

// Returns null when the caller is the owner, otherwise a ready-made error response.
export async function requireOwner(req: Request): Promise<Response | null> {
  const auth = req.headers.get('Authorization');
  if (!auth) return reply(req, { code: 'session_expired', message: 'Please sign in again.' }, 401);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data, error } = await sb.from('profiles').select('role').maybeSingle();
  if (error || !data) return reply(req, { code: 'session_expired', message: 'Please sign in again.' }, 401);
  if (data.role !== 'owner') return reply(req, { code: 'not_granted', message: 'Only the owner can run refreshes.' }, 403);
  return null;
}
