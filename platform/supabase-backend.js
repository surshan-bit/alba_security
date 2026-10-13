// Supabase backend for the document store. UNVERIFIED until a real Supabase project exists (see supabase/schema.sql).
// `sb` is a supabase-js client (createClient(url, anonKey)), passed in so this file has no dependency of its own.
function createSupabaseBackend(sb){
  const subs = new Set();
  const fire = (p) => subs.forEach(cb => cb(p));
  const fail = (error) => { if(error){ const e = new Error(error.message || 'database error'); e.code = error.code; throw e; } };
  // other browsers' changes arrive through Realtime; our own writes fire locally at once
  sb.channel('docs-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, (m) => {
    const row = m.new && m.new.path ? m.new : m.old; if(row && row.path) fire(row.path);
  }).subscribe();
  return {
    get: async (path) => { const { data, error } = await sb.from('docs').select('data').eq('path', path).maybeSingle(); fail(error); return data ? data.data : undefined; },
    put: async (path, d) => { const { error } = await sb.from('docs').upsert({ path, data: d, updated_at: new Date().toISOString() }); fail(error); fire(path); },
    merge: async (path, d) => { const { error } = await sb.rpc('docs_merge', { p_path: path, p_data: d }); fail(error); fire(path); },
    remove: async (path) => { const { error } = await sb.from('docs').delete().eq('path', path); fail(error); fire(path); },
    list: async (parent) => {
      const out = []; const PAGE = 1000;
      for(let from = 0; ; from += PAGE){
        const { data, error } = await sb.from('docs').select('id,data').eq('parent', parent).order('id').range(from, from + PAGE - 1); fail(error);
        out.push(...data.map(r => ({ id: r.id, data: r.data })));
        if(data.length < PAGE) break;
      }
      return out;
    },
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); }
  };
}
export { createSupabaseBackend };
