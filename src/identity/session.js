// Who is viewing: the claude.ai `user` capability (organization members). Anyone without an identity (public link / outside
// the organization) gets no uid and keeps browser-only settings.
//  * Collection `users/<uid>` (shared, admin-readable): one small record per user {v, firstSeenAt, lastSeenAt}. Ids only,
//    never names or emails.
//  * Private to each user (nobody else can read it, not even the owner): data/users/<uid>/prefs (theme, filters and
//    sort, analysis filters, trade view), data/users/<uid>/pins, data/users/<uid>/strategies, and the trade log in
//    data/users/<uid>/portfolio/trades/<TICKER>-<date>.

const state = {
  uid: null,   // the signed-in member's id, or null
  db: null     // the database handle used for the records above (set together with uid, null when there is none)
};

// Runs once before the app starts.
async function loadIdentity(){
  try {
    if(!(typeof claude !== 'undefined' && claude && typeof claude.use === 'function')) return;
    const [db, user] = await Promise.all([claude.use('db').catch(() => null), claude.use('user').catch(() => null)]);
    state.db = db;
    // The viewer's id can be slow or briefly empty right after a reload; asking again a few times keeps the saved pins,
    // preferences and strategies from silently going missing for that page load.
    let id = null;
    for(let i = 0; i < 4 && !id; i++){
      if(i) await new Promise(r => setTimeout(r, 500 * i));
      try { id = user ? await user.id() : null; } catch(e){ id = null; }
      if(!user || !db) break;
    }
    state.uid = (db && id) ? String(id) : null;
  } catch(e){ state.uid = null; }
}
function getUid(){ return state.uid; }
function getIdentityDb(){ return state.db; }
function userRef(path){
  return (state.db && state.uid) ? state.db.doc(path.replace('{uid}', state.uid)) : null;
}
function pinsRef(db){ return (db && state.uid) ? db.doc('data/users/' + state.uid + '/pins') : null; }
function signalCol(db){ return (db && state.uid) ? db.doc('data/users/' + state.uid + '/portfolio').collection('signals') : null; }
function tradeCol(db){ return (db && state.uid) ? db.doc('data/users/' + state.uid + '/portfolio').collection('trades') : null; }

// Keeps the user record current (created on first visit, last-seen refreshed at most every 6 hours).
async function touchUser(){
  const ref = userRef('users/{uid}');
  if(!ref) return;
  try {
    const s = await ref.get(), now = new Date().toISOString();
    if(!s || !s.exists) await ref.set({ v: 1, firstSeenAt: now, lastSeenAt: now });
    else if(Date.now() - (Date.parse((s.data() || {}).lastSeenAt) || 0) > 6 * 3600 * 1000) await ref.update({ lastSeenAt: now });
  } catch(e){ /* the user record is optional */ }
}

export { getIdentityDb, getUid, loadIdentity, pinsRef, signalCol, touchUser, tradeCol, userRef };
