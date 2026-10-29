// Refresh kit: the saved queue of refresh jobs, the runner that feeds the Live Data Refresh engine, the notices in the bell,
// and the other-device sync. It knows nothing about the buttons and menus: those live in kit-controls.js and reach this module through
// its exported functions, and this module reaches them only through the hooks they register (setQueueHooks).
import { LD_BATCH_MAX, getLdBatch, ldBatchStart, ldBatchStop } from '../livedata/batch.js';
import { activityDropWhere, activityEnd, activityNotify, activityRun, setNoticeDismissHandler } from '../ui/activity.js';
import { pcTickerKey } from '../prices/store.js';
import { sleep } from '../core/util.js';
import { tvMcp } from '../tv/connector.js';
import { dbCapabilityPromise } from '../core/store.js';
import { registerBusy } from '../core/busy.js';
import { userRef } from '../identity/session.js';
import { needs, priorityOrder } from './freshness.js';
import { isExternalSelection, sectionOf, selKeys, stockByKey } from './kit-lookup.js';

const KIND_LABEL = { fund: "Fundamental", tech: "Technical" };
const CHUNK = Math.min(50, LD_BATCH_MAX.fund, LD_BATCH_MAX.tech);   // stocks per engine batch
const CAP = { fund: Infinity, tech: 1000 };                         // most stocks one press may queue (no limit on Fundamental since v1.297)
const CONFIRM_OVER = { fund: 50, tech: 100 };                       // above this the user is asked first
const LS_KEY = "albaDashboard.refreshQueue.v1";
const HEARTBEAT_MS = 15000, TAKEOVER_MS = 45000;
const tabId = Math.random().toString(36).slice(2, 10);

// The controls register what the queue needs from them (redraw the buttons, update the row ticks, open the confirmation menu).
const hooks = { repaint: () => {}, syncChecks: () => {}, openConfirm: (anchor, spec, plan) => {} };
function setQueueHooks(h) { Object.assign(hooks, h); }
const repaint = () => hooks.repaint();

// ---------- queue state ----------
let queue = [];              // jobs, the first may be running
let activeJob = null;
let pumping = false;
let history = [];            // last finished-job notices, kept across a reload
let heartbeat = null, persistTimer = null, lastSaved = "";
let progress = null;         // what the running job last reported (title, text, pct): saved so other devices can show it
let remote = null;           // a refresh that another device is running: { jobs, stale }
let lastRemoteData = null, starting = true, taking = false;
let claimedAt = 0, lastWriteAt = 0;   // when this tab took the run, and when it last saved it
let stopHandled = 0, stopPending = false, stopAsked = 0, yielded = false;
const remoteIds = new Set(); // bell items drawn for the other device's jobs
const seen = new Set();      // notices already in the bell, by time and title
let dismissed = [];          // keys of notices the viewer removed: they never come back, on any device
const noticeKey = (n) => (n.at || 0) + "|" + (n.title || "");
const isDismissed = (n) => dismissed.includes(noticeKey(n));
function dismissNotices(list) {
  const keys = (list || []).map(noticeKey);
  if (!keys.length) return;
  dismissed = keys.concat(dismissed.filter((k) => !keys.includes(k))).slice(0, 200);
  history = history.filter((n) => !keys.includes(noticeKey(n)));
  persistNow();
}
const hbAge = (d) => Date.now() - (Date.parse(d && d.heartbeatAt) || 0);
const remoteBusy = () => !!(remote && remote.jobs.length);
const isBusy = () => queue.length > 0 || remoteBusy();
// Only the screen that started the refresh shows the spinner; the other screens keep a normal Refresh button.
const runSection = () => { const j = queue[0] || (remote && remote.jobs[0]); return j ? sectionOf(j.source) : ""; };
const busyIn = (sec) => isBusy() && !!sec && runSection() === sec;
const jobId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function jobView(j) {
  const b = j === activeJob ? getLdBatch() : null;
  const progressed = b && b.running ? Math.min(j.keys.length, b.done) : 0;
  return { id: j.id, kind: j.kind, keys: j.keys.slice(progressed), total: j.total, done: j.done + progressed, source: j.source, label: j.label, force: !!j.force, createdAt: j.createdAt };
}
function docData() {
  return { v: 1, jobs: queue.map(jobView), notices: history.filter((n) => !isDismissed(n)).slice(0, 10), dismissed, progress: activeJob ? progress : null, owner: queue.length ? tabId : null, heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
async function writeNow() {
  persistTimer = null;
  const data = docData(), sig = JSON.stringify([data.jobs, data.notices]);
  if (sig === lastSaved && !queue.length) return;
  lastSaved = sig;
  const ref = userRef("data/users/{uid}/refreshQueue");
  if (yielded) return;
  try {
    // Waking from sleep: another device may have taken the run over meanwhile. Check before writing over it.
    if (ref && queue.length && lastWriteAt && Date.now() - lastWriteAt > TAKEOVER_MS * 0.66) {
      const snap = await ref.get(), cur = snap && snap.exists ? snap.data() : null;
      if (cur && cur.v === 1 && cur.owner && cur.owner !== tabId && hbAge(cur) < TAKEOVER_MS && liveJobs(cur).length) { lastSaved = ""; lastRemoteData = cur; yieldRun(); return; }
    }
    if (ref && !queue.length && remoteBusy()) await ref.update({ notices: data.notices, dismissed, updatedAt: data.updatedAt });   // another device owns the run: only add our notices
    else if (ref) await ref.set(data);
    else localStorage.setItem(LS_KEY, JSON.stringify(data));
    lastWriteAt = Date.now();
  } catch (e) { console.error("Could not save the refresh queue", e); }
}
function persistSoon() { if (!persistTimer) persistTimer = setTimeout(writeNow, 5000); }
function persistNow() { clearTimeout(persistTimer); persistTimer = null; return writeNow(); }
async function loadSaved() {
  const ref = userRef("data/users/{uid}/refreshQueue");
  if (ref) {
    try { const snap = await ref.get(); return snap && snap.exists ? snap.data() : null; } catch (e) { console.error("Could not read the refresh queue", e); return null; }
  }
  try { const t = localStorage.getItem(LS_KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; }
}

// ---------- notifications ----------
function notice(n) {
  const item = { tone: n.tone, title: n.title, text: n.text, section: n.section || "", at: Date.now() };
  history.unshift(item); seen.add(noticeKey(item));
  history = history.slice(0, 10);
  activityNotify(Object.assign({}, n, { at: item.at }));
  persistNow();
}
function queuedItem(j) {
  activityRun("rk-q-" + j.id, {
    title: "Queued: " + KIND_LABEL[j.kind] + " refresh · " + j.keys.length + " stock" + (j.keys.length === 1 ? "" : "s"),
    text: (j.label ? j.label + " · " : "") + "Waiting for the current refresh to finish.",
    pct: 0, section: sectionOf(j.source),
    onStop: () => removeJob(j.id)
  });
}
function activity(info) {
  const j = activeJob, b = getLdBatch();
  if (!j || !b) { activityRun("batch", info); return; }
  const more = queue.length - 1;
  const done = j.done + Math.min(b.done, b.total);
  const frac = (j.done + (info.pct || 0) / 100 * b.total) / j.total;
  const shown = Object.assign({}, info, {
    title: "Refreshing " + KIND_LABEL[j.kind] + " Info · " + done + " of " + j.total + " done" + (more > 0 ? " · " + more + " more queued" : ""),
    pct: Math.round(Math.min(1, frac) * 100)
  });
  progress = { title: shown.title, text: info.text || "", pct: shown.pct, section: shown.section || sectionOf(j.source) };
  activityRun("batch", shown);
  persistSoon();
}
function batchNotice() {
  // The engine reports once per batch of up to 50 stocks; the kit sums them up and reports once per job (see finishJob).
  const j = activeJob, b = getLdBatch();
  if (!j || !b) return false;
  j.stats.refreshed += Math.max(0, b.total - b.failed.length - b.skipped);
  j.stats.notRun += b.skipped;
  j.stats.failed.push(...b.failed);
  if (b.stop) j.stats.stopped = true;
  if (b.note && !/^Finished/.test(b.note)) j.stats.note = b.note;
  if (b.perm) j.stats.perm = true;
  return true;
}
function finishJob(j) {
  if (yielded) return;   // another device carries the run on: it reports the result
  const st = j.stats, ended = st.stopped || !!st.note;
  const failed = st.failed.length > 0;
  const tail = st.refreshed + " of " + j.total + " refreshed." + (st.notRun ? " " + st.notRun + " not run." : "") + (failed ? " Failed: " + st.failed.slice(0, 5).join("; ") + (st.failed.length > 5 ? "; …" : "") : "");
  notice({
    tone: failed ? (st.refreshed > 0 ? "warn" : "error") : ended ? "warn" : "ok",
    title: KIND_LABEL[j.kind] + " refresh " + (st.stopped ? "stopped" : ended ? "ended early" : "finished") + (j.label ? " · " + j.label : ""),
    text: (st.note && !st.stopped ? st.note + " " : "") + tail,
    section: sectionOf(j.source)
  });
}

// ---------- the queue and its runner ----------
function removeJob(id) {
  const i = queue.findIndex((j) => j.id === id);
  if (i < 0 || queue[i] === activeJob) return;
  queue.splice(i, 1);
  activityEnd("rk-q-" + id);
  persistNow(); repaint();
}
function queuedKeys(kind) {
  const set = new Set();
  queue.filter((j) => j.kind === kind).forEach((j) => j.keys.forEach((k) => set.add(k)));
  return set;
}
function enqueueJob(kind, list, source, label, force) {
  const already = queuedKeys(kind);
  const keys = [];
  for (const s of list) { const k = pcTickerKey(s); if (!already.has(k) && !keys.includes(k)) keys.push(k); }
  if (!keys.length) return 0;
  const j = { id: jobId(), kind, keys, total: keys.length, done: 0, source: source || "", label: label || "", force: !!force && kind === "fund", createdAt: Date.now(), stats: { refreshed: 0, notRun: 0, failed: [], stopped: false, note: "", perm: false } };
  if (!queue.length) claimedAt = Date.now();
  queue.push(j);
  if (queue.length > 1) queuedItem(j);
  persistNow(); repaint(); pump();
  return keys.length;
}
const engineBusy = () => { const b = getLdBatch(); return !!(b && b.running); };
async function pump() {
  if (pumping) return;
  pumping = true;
  if (!heartbeat) heartbeat = setInterval(() => { if (queue.length) persistNow(); }, HEARTBEAT_MS);
  try {
    while (queue.length) {
      const job = queue[0];
      while (engineBusy()) await sleep(500);
      if (!queue.length) break;
      if (stopPending) {   // Stop was pressed on another device between two batches
        stopPending = false; queue.shift(); activeJob = null; activityEnd("rk-q-" + job.id);
        job.stats.stopped = true; finishJob(job); persistNow(); continue;
      }
      const list = job.keys.slice(0, CHUNK).map(stockByKey).filter(Boolean);
      if (!list.length) { queue.shift(); activityEnd("rk-q-" + job.id); continue; }
      activeJob = job; activityEnd("rk-q-" + job.id);
      persistSoon(); repaint();
      const before = getLdBatch();
      await ldBatchStart(job.kind, list, job.source || "strat");
      const b = getLdBatch();
      if (b === before) { await sleep(800); continue; }     // the engine did not take the batch (busy or refused): try again
      batchNoticeDone(job, list.length, b);
    }
  } finally {
    activeJob = null; pumping = false;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    stopPending = false;
    persistNow(); yielded = false; repaint();
  }
}
function batchNoticeDone(job, taken, b) {
  job.keys = job.keys.slice(taken);
  job.done += taken;
  const halted = !!(b.note && /^Stopped early/.test(b.note)), over = b.stop || halted || job.keys.length === 0;
  if (!over) { persistSoon(); return; }
  queue.shift();
  activeJob = null;
  finishJob(job);
  if (halted) {
    // A usage limit or a missing permission would stop every Fundamental job in the same way: take them off the queue.
    const drop = queue.filter((j) => j.kind === job.kind);
    if (drop.length) { drop.forEach((j) => { queue.splice(queue.indexOf(j), 1); activityEnd("rk-q-" + j.id); }); notice({ tone: "warn", title: "Queued " + KIND_LABEL[job.kind] + " refreshes removed", text: drop.length + " queued job" + (drop.length === 1 ? "" : "s") + " were taken off the queue because " + String(b.note || "the refresh stopped early").replace(/^Stopped early: /, "").replace(/\.$/, "") + ".", section: sectionOf(job.source) }); }
  }
  persistSoon();
}

// ---------- running from the controls ----------
function request(spec, anchor) {
  if (remoteBusy()) {
    const n = remote.jobs.reduce((t, j) => t + j.keys.length, 0);
    notice({ tone: "warn", title: "A refresh is already in progress", text: "Another device is " + (remote.stale ? "paused on" : "running") + " a refresh with " + n + " stock" + (n === 1 ? "" : "s") + " left. Start a new one when it has finished.", section: "" });
    return;
  }
  const plan = [];
  for (const kind of ["tech", "fund"]) {
    if (!spec.kinds.includes(kind)) continue;
    let l = spec.only ? priorityOrder(kind, spec.list.filter((s) => needs(kind, s))) : spec.list;
    if (spec.only && l.length > CAP[kind]) {
      notice({ tone: "warn", title: "Refreshing the most important first", text: l.length + " stocks need a " + KIND_LABEL[kind] + " refresh. This run takes the " + CAP[kind] + " that matter most (new results, news or big moves first, then pinned, then stocks matching a strategy, then the oldest). Run it again for the rest.", section: "" });
      l = l.slice(0, CAP[kind]);
    }
    if (l.length) plan.push({ kind, list: l });
  }
  if (!plan.length) {
    notice({ tone: "ok", title: "Nothing to refresh", text: "Everything in this list is already up to date. Use the buttons (not “only those that need it”) to refresh anyway.", section: "" });
    return;
  }
  const over = plan.find((p) => p.list.length > CAP[p.kind]);
  if (over) {
    notice({ tone: "warn", title: "Too many stocks for one refresh", text: KIND_LABEL[over.kind] + " refresh takes up to " + CAP[over.kind] + " stocks at a time and you chose " + over.list.length + ". Narrow the list (a strategy, Matched, a selection) and try again.", section: "" });
    return;
  }
  const big = plan.find((p) => p.list.length > CONFIRM_OVER[p.kind]);
  if (big && !spec.confirmed) { hooks.openConfirm(anchor, spec, plan); return; }
  let added = 0;
  for (const p of plan) added += enqueueJob(p.kind, p.list, spec.source, spec.label, spec.only);
  if (!added) notice({ tone: "ok", title: "Already queued", text: "These stocks are already waiting in the refresh queue or being refreshed.", section: "" });
  if (spec.selName && spec.clearSel && !isExternalSelection(spec.selName)) { selKeys(spec.selName).clear(); hooks.syncChecks(); }
  repaint();
}
function enqueueOne(s, kind) {
  request({ list: [s], kinds: [kind], only: false, source: "detail", label: s.name }, null);
}

// ---------- other devices: the saved record is shared, so every device shows the same status ----------
function clearRemote() {
  remoteIds.forEach((id) => activityEnd(id)); remoteIds.clear();
  if (remote) { remote = null; repaint(); }
}
function applyRemote(d) {
  lastRemoteData = d;
  if (!d || d.v !== 1) { clearRemote(); return; }
  if (Array.isArray(d.dismissed)) {   // notices removed on another device disappear here too
    const gone = d.dismissed.filter((k) => !dismissed.includes(k));
    dismissed = d.dismissed.concat(dismissed.filter((k) => !d.dismissed.includes(k))).slice(0, 200);
    if (gone.length) { history = history.filter((n) => !isDismissed(n)); activityDropWhere((n) => isDismissed(n)); }
  }
  // notices written by another device (or an earlier visit) that this device has not shown yet
  (Array.isArray(d.notices) ? d.notices : []).slice().reverse().forEach((n) => {
    if (!n || !n.title || seen.has(noticeKey(n)) || isDismissed(n)) return;
    seen.add(noticeKey(n));
    history.unshift({ tone: n.tone || "ok", title: n.title, text: n.text || "", section: n.section || "", at: n.at || Date.now() });
    activityNotify({ tone: n.tone || "ok", title: n.title, text: n.text || "", section: n.section || "", at: n.at || Date.now() });
  });
  history = history.slice(0, 10);
  const jobs = liveJobs(d);
  if (queue.length && d.owner && d.owner !== tabId && jobs.length && hbAge(d) < TAKEOVER_MS) { yieldRun(); }   // another device has the run: do not run it twice
  if (queue.length && d.owner === tabId && d.stopRequest > Math.max(stopHandled, claimedAt)) {   // Stop was pressed on another device
    stopHandled = d.stopRequest;
    if (engineBusy()) ldBatchStop(); else stopPending = true;
  }
  if (!jobs.length || d.owner === tabId || queue.length) { clearRemote(); return; }
  if (stopAsked && (!fresh0(d) || Date.now() - stopAsked > 90000)) stopAsked = 0;
  const fresh = fresh0(d), left = jobs.reduce((n, j) => n + j.keys.length, 0), j0 = jobs[0], p = d.progress || null;
  const pct = p && typeof p.pct === "number" ? p.pct : Math.round((j0.done / Math.max(1, j0.total)) * 100);
  const ids = new Set(["rk-remote"]);
  activityRun("rk-remote", {
    title: fresh ? (p && p.title) || "Refreshing " + KIND_LABEL[j0.kind] + " Info · " + j0.done + " of " + j0.total + " done" : "Refresh paused · " + KIND_LABEL[j0.kind] + " · " + left + " stock" + (left === 1 ? "" : "s") + " left",
    text: stopAsked ? "Stopping… waiting for the other device to stop." : fresh ? ((p && p.text) ? p.text + " · " : "") + "Running on another device." : "No dashboard is working on it right now. It carries on when one with TradingView is open.",
    pct, section: sectionOf(j0.source),
    onStop: remoteStop, stopping: !!stopAsked
  });
  jobs.slice(1).forEach((j) => {
    const id = "rk-remote-q-" + j.id; ids.add(id);
    activityRun(id, { title: "Queued: " + KIND_LABEL[j.kind] + " refresh · " + j.keys.length + " stock" + (j.keys.length === 1 ? "" : "s"), text: (j.label ? j.label + " · " : "") + "Waiting for the current refresh to finish.", pct: 0, section: sectionOf(j.source) });
  });
  remoteIds.forEach((id) => { if (!ids.has(id)) activityEnd(id); });
  remoteIds.clear(); ids.forEach((id) => remoteIds.add(id));
  remote = { jobs, stale: !fresh }; repaint();
  if (!fresh && !starting) takeOver();
}
const fresh0 = (d) => hbAge(d) < TAKEOVER_MS;
// Stop pressed on a device that is not running the refresh: ask the running one, or clear a paused job.
async function remoteStop() {
  const ref = userRef("data/users/{uid}/refreshQueue"), d = lastRemoteData;
  if (!ref || !d || stopAsked) return;
  const jobs = liveJobs(d);
  if (!jobs.length) return;
  stopAsked = Date.now();
  try {
    if (fresh0(d)) await ref.update({ stopRequest: stopAsked });
    else {
      const j = jobs[0];
      await ref.update({ jobs: jobs.slice(1), progress: null, owner: null, updatedAt: new Date().toISOString() });
      stopAsked = 0;
      notice({ tone: "warn", title: KIND_LABEL[j.kind] + " refresh stopped" + (j.label ? " · " + j.label : ""), text: "Stopped from this device. " + j.done + " of " + j.total + " done before it was paused.", section: sectionOf(j.source) });
    }
  } catch (e) { stopAsked = 0; console.error("Could not stop the refresh", e); }
  if (lastRemoteData) applyRemote(lastRemoteData);
}
// This tab was running a refresh that another device has now taken over (this one slept or lost contact): stop without saving.
function yieldRun() {
  if (!queue.length) return;
  const dropped = queue; queue = [];
  dropped.forEach((j) => activityEnd("rk-q-" + j.id));
  activityEnd("batch");
  if (pumping) { yielded = true; if (engineBusy()) ldBatchStop(); }
  stopPending = false; repaint();
  if (lastRemoteData) setTimeout(() => applyRemote(lastRemoteData), 0);
}
const liveJobs = (d) => (Array.isArray(d && d.jobs) ? d.jobs : []).filter((j) => j && KIND_LABEL[j.kind] && Array.isArray(j.keys) && j.keys.length);
const freshStats = () => ({ refreshed: 0, notRun: 0, failed: [], stopped: false, note: "", perm: false });
// Shows the resumed job in the bell at once (the engine's own progress card replaces it when the first batch starts).
function showResuming() {
  const j = queue[0];
  if (!j) return;
  const left = queue.reduce((n, x) => n + x.keys.length, 0);
  activityRun("batch", {
    title: "Refreshing " + KIND_LABEL[j.kind] + " Info · " + j.done + " of " + j.total + " done" + (queue.length > 1 ? " · " + (queue.length - 1) + " more queued" : ""),
    text: "Starting again where it stopped (" + left + " stock" + (left === 1 ? "" : "s") + " left)…",
    pct: Math.round((j.done / Math.max(1, j.total)) * 100), section: sectionOf(j.source),
    onStop: () => { if (activeJob || engineBusy()) return; queue.forEach((x) => activityEnd("rk-q-" + x.id)); queue = []; activityEnd("batch"); persistNow(); repaint(); }
  });
}
// A job nobody has worked on for a while: the first open dashboard that can reach TradingView picks it up.
async function takeOver() {
  if (taking || queue.length) return;
  taking = true;
  try {
    await sleep(Math.random() * 3000);
    const again = await loadSaved();
    if (!again || again.v !== 1 || queue.length || hbAge(again) < TAKEOVER_MS) return;
    const jobs = liveJobs(again);
    if (!jobs.length) return;
    let mcp = null; try { mcp = await tvMcp(); } catch (e) { mcp = null; }
    if (!mcp) return;
    claimedAt = Date.now();
    queue = jobs.map((j) => Object.assign({}, j, { stats: freshStats() }));
    clearRemote();
    queue.slice(1).forEach(queuedItem);
    showResuming();
    await persistNow();   // claims the run: the other dashboards see a fresh heartbeat from this one
    setTimeout(pump, 1000);
  } finally { taking = false; }
}
function watchRemote() {
  const ref = userRef("data/users/{uid}/refreshQueue");
  if (!ref || typeof ref.onSnapshot !== "function") return;
  try { ref.onSnapshot((snap) => applyRemote(snap && snap.exists ? snap.data() : null), (e) => console.error("Refresh status sync error", e)); }
  catch (e) { console.error("Refresh status sync unavailable", e); return; }
  setInterval(() => { if (lastRemoteData) applyRemote(lastRemoteData); }, 10000);   // notices a run that has gone quiet
}

// ---------- start-up: restore the saved queue and carry on ----------
// ---------- start-up: restore the saved queue and carry on ----------
async function initQueue() {
  setNoticeDismissHandler(dismissNotices);
  registerBusy(() => queue.length > 0 || engineBusy());
  try { await dbCapabilityPromise; } catch (e) { /* no database: the browser copy is used */ }
  const saved = await loadSaved();
  if (saved && saved.v === 1) {
    dismissed = Array.isArray(saved.dismissed) ? saved.dismissed.slice(0, 200) : [];
    history = (Array.isArray(saved.notices) ? saved.notices : []).filter((n) => !isDismissed(n)).slice(0, 10);
    history.slice().reverse().forEach((n) => { seen.add(noticeKey(n)); activityNotify({ tone: n.tone || "ok", title: n.title || "", text: n.text || "", section: n.section || "", at: n.at || Date.now(), read: true, silent: true }); });
  }
  watchRemote();
  try { if (saved && saved.v === 1) await resumeSaved(saved); }
  finally { starting = false; if (lastRemoteData) applyRemote(lastRemoteData); }
}
async function resumeSaved(saved) {
  let jobs = liveJobs(saved);
  if (!jobs.length) return;
  // A fresh heartbeat from another tab usually means this page was reloaded while a refresh was running:
  // wait a moment, and carry on from where it stopped once that tab has gone quiet.
  let waited = 0;
  while (saved && saved.owner && saved.owner !== tabId && hbAge(saved) < TAKEOVER_MS && waited < 70000) {
    await sleep(5000); waited += 5000;
    const again = await loadSaved();
    if (!again || again.v !== 1) return;
    saved = again; jobs = liveJobs(saved);
    if (!jobs.length) return;
  }
  if (saved.owner && saved.owner !== tabId && hbAge(saved) < TAKEOVER_MS) return;   // still being worked on elsewhere: the bell already shows it
  let mcp = null;
  try { mcp = await tvMcp(); } catch (e) { mcp = null; }
  if (!mcp) return;   // this view cannot reach TradingView: the bell shows the paused job and a dashboard that can will carry on
  claimedAt = Date.now();
  queue = jobs.map((j) => Object.assign({}, j, { stats: freshStats() }));
  clearRemote();
  queue.slice(1).forEach(queuedItem);
  showResuming();
  setTimeout(pump, 1500);
}

// What the controls read about the queue.
const getActiveJob = () => activeJob;
const queuedJobs = () => queue;
const flushQueue = () => { if (queue.length) writeNow(); };   // the page is being left: save the queue now
const persistIfRunning = () => { if (activeJob) persistSoon(); };

export { CHUNK, KIND_LABEL, activity, batchNotice, busyIn, enqueueOne, flushQueue, getActiveJob, initQueue, persistIfRunning, queuedJobs, request, setQueueHooks };
