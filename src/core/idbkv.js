// Opens a small IndexedDB key-value cache (database `name`, one object store `store`). Resolves null when IndexedDB is not available,
// so a cache is always optional.
function openKvDb(name, store){
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore(store); } catch(e){ /* the cache is optional */ } };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch(e){ resolve(null); }
  });
}

export { openKvDb };
