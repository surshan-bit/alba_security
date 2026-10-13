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

// sample: Claude calls run in a private server function that holds the Anthropic key (supabase/functions/sample).
// Same call style as the claude.ai runtime: sample(prompt, { modelTier }) or sample({ prompt, modelTier }), answering { text }.
function claudeSample(sb){
  return async (promptOrReq, opts) => {
    const req = (promptOrReq && typeof promptOrReq === 'object') ? promptOrReq : Object.assign({}, opts, { prompt: promptOrReq });
    const { data, error } = await sb.functions.invoke('sample', { body: { prompt: req.prompt, modelTier: req.modelTier } });
    if(error){
      let info = null;
      try { info = error.context && await error.context.json(); } catch(e){ /* no body */ }
      throw Object.assign(new Error((info && info.message) || error.message || 'Claude did not answer.'), { code: (info && info.code) || 'sample_error' });
    }
    if(typeof req.onText === 'function'){ try { req.onText(data.text); } catch(e){ /* progress only */ } }
    return { text: data.text };
  };
}

// mcp: the TradingView connector will be a private server function too (not built yet), so for now the app finds none.

export { installPlatform, supabaseUser, supabaseAssets, claudeSample };
