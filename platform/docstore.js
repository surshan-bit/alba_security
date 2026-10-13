// Document-store emulation: gives the app the same db object claude.ai gives (doc / collection / get / set / update / delete /
// onSnapshot / where), on top of a small backend. The backend is either memory (tests) or Supabase (platform/supabase-backend.js).
// Backend contract (all async except onChange):
//   get(path) -> data | undefined      put(path, data)      merge(path, data)      remove(path)
//   list(parent) -> [{ id, data }]     onChange(cb(path)) -> unsubscribe   (cb fires after any write, local or remote)
const clone = (x) => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
const idOf = (p) => p.slice(p.lastIndexOf('/') + 1);

const getField = (data, field) => String(field).split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
const OPS = {
  '==': (a, b) => a === b, '!=': (a, b) => a !== b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  'in': (a, b) => Array.isArray(b) && b.includes(a), 'array-contains': (a, b) => Array.isArray(a) && a.includes(b)
};

function createDocStore(backend){
  const snap = (id, d) => ({ id, exists: d !== undefined, data: () => clone(d) });
  const colSnap = (rows) => {
    const docs = rows.map(r => snap(r.id, r.data));
    return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f), docChanges: () => [] };
  };

  function mkDoc(path){
    return {
      id: idOf(path), path,
      get: async () => snap(idOf(path), await backend.get(path)),
      set: async (d) => { await backend.put(path, clone(d)); },
      update: async (d) => { await backend.merge(path, clone(d)); },
      delete: async () => { await backend.remove(path); },
      onSnapshot: (cb) => {
        let live = true;
        const push = async () => { try { const d = await backend.get(path); if(live) cb(snap(idOf(path), d)); } catch(e){ /* the next change tries again */ } };
        const off = backend.onChange((p) => { if(p === path) push(); });
        push();
        return () => { live = false; off(); };
      },
      collection: (n) => mkCol(path + '/' + n)
    };
  }

  // A collection query: where() / orderBy() / limit() narrow it; each returns a new query, like the original.
  function mkCol(path, q = { where: [], order: null, max: null }){
    const run = async () => {
      let rows = await backend.list(path);
      for(const [f, op, v] of q.where) rows = rows.filter(r => OPS[op] && OPS[op](getField(r.data, f), v));
      if(q.order){ const { f, dir } = q.order; rows = rows.slice().sort((a, b) => { const x = getField(a.data, f), y = getField(b.data, f); return (x < y ? -1 : x > y ? 1 : 0) * dir; }); }
      if(q.max != null) rows = rows.slice(0, q.max);
      return rows;
    };
    const next = (patch) => mkCol(path, Object.assign({}, q, patch));
    return {
      path,
      doc: (id) => mkDoc(path + '/' + id),
      get: async () => colSnap(await run()),
      onSnapshot: (cb) => {
        let live = true;
        const push = async () => { try { const rows = await run(); if(live) cb(colSnap(rows)); } catch(e){ /* the next change tries again */ } };
        const off = backend.onChange((p) => { if(parentOf(p) === path) push(); });
        push();
        return () => { live = false; off(); };
      },
      where: (f, op, v) => next({ where: q.where.concat([[f, op, v]]) }),
      orderBy: (f, d) => next({ order: { f, dir: d === 'desc' ? -1 : 1 } }),
      limit: (n) => next({ max: n })
    };
  }
  return { doc: (p) => mkDoc(p), collection: (n) => mkCol(n) };
}

// In-memory backend: the reference behaviour, used by the contract tests and as a stand-in for the Supabase backend.
function createMemoryBackend(seed = {}){
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, clone(v)])), subs = new Set();
  const fire = (p) => subs.forEach(cb => cb(p));
  return {
    store,
    get: async (p) => clone(store.get(p)),
    put: async (p, d) => { store.set(p, clone(d)); fire(p); },
    merge: async (p, d) => { store.set(p, Object.assign({}, store.get(p) || {}, clone(d))); fire(p); },
    remove: async (p) => { store.delete(p); fire(p); },
    list: async (parent) => { const out = []; for(const [k, v] of store) if(parentOf(k) === parent) out.push({ id: idOf(k), data: clone(v) }); return out; },
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); }
  };
}

export { createDocStore, createMemoryBackend };
