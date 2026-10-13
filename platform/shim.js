// window.claude for the real site: the same claude.use(name) the app already calls, backed by our own services.
//   installPlatform({ backend, user, assets, mcp, sample, permissions })  ->  sets window.claude
// Each part is optional: a missing one answers null, which the app treats as "not available" (as it does today).
import { createDocStore } from './docstore.js';

function installPlatform(parts, target = globalThis){
  const db = parts.backend ? createDocStore(parts.backend) : null;
  const caps = {
    db,
    user: parts.user || null,
    assets: parts.assets || null,
    mcp: parts.mcp || null,
    sample: parts.sample || null,
    permissions: parts.permissions || { state: async () => 'granted', request: async () => ({}), manage: async () => {} }
  };
  // never resolves synchronously, like the original runtime
  target.claude = { use: async (name) => (name in caps ? caps[name] : null) };
  return target.claude;
}

// user: Google sign-in through Supabase. id() is the signed-in Gmail account's stable id; isOwner() is true only for the owner account.
function supabaseUser(sb, ownerEmail){
  let cur = null;
  const ready = sb.auth.getSession().then(({ data }) => { cur = data && data.session ? data.session.user : null; });
  sb.auth.onAuthStateChange((_e, s) => { cur = s ? s.user : null; });
  return {
    id: async () => { await ready; return cur ? cur.id : null; },
    email: async () => { await ready; return cur ? cur.email : null; },
    isOwner: () => !!cur && !!ownerEmail && cur.email === ownerEmail   // a display hint only: the database rules decide what is really allowed
  };
}

// assets: files go to a Supabase Storage bucket, under the signed-in user's folder.
function supabaseAssets(sb, bucket = 'assets'){
  return {
    upload: async (blob) => {
      const { data: s } = await sb.auth.getSession(); const uid = s.session && s.session.user.id;
      const id = (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
      const path = uid + '/' + id;
      const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: blob.type || 'application/octet-stream' });
      if(error) throw new Error(error.message);
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return { id: path, url: data.publicUrl, sizeBytes: blob.size, contentType: blob.type };
    },
    delete: async (id) => { const { error } = await sb.storage.from(bucket).remove([id]); if(error) throw new Error(error.message); }
  };
}

// mcp / sample: owner-only server functions (they hold the TradingView and Claude keys, which must never reach a browser).
function edgeFunctions(sb){
  const call = async (fn, body) => { const { data, error } = await sb.functions.invoke(fn, { body }); if(error) throw new Error(error.message); return data; };
  return {
    mcp: { callTool: (server, tool, input) => call('mcp-call', { server, tool, input }) },
    sample: async (req) => call('sample', req)
  };
}

export { installPlatform, supabaseUser, supabaseAssets, edgeFunctions };
