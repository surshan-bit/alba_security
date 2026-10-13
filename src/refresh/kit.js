// Refresh kit (v1.121): one place for everything about refreshing Fundamental and Technical info from a list of stocks.
//   - controls: the buttons in a table's header line, the "more" menu, the Explorer toolbar menu, the row checkboxes and the
//     selection bar, and the little F / T freshness badges next to a stock's name
//   - a saved queue of refresh jobs that runs the existing Live Data Refresh engine (ldBatchStart) one batch at a time
//   - notifications: queued / running / finished jobs in the bell, kept across a reload
// A refresh does not need the page to stay open in the sense that the job is saved: close the page and it carries on from where
// it stopped when the dashboard is opened again (it still needs an open dashboard to run: TradingView and Claude are reached
// through the page).
import { LD_BATCH_MAX, getLdBatch, ldBatchStart, ldBatchStop } from '../livedata/batch.js';
import { activityDropWhere, activityEnd, activityNotify, activityRun, setNoticeDismissHandler } from '../ui/activity.js';
import { pcTickerKey } from '../prices/store.js';
import { tvMcp } from '../tv/connector.js';
import { escapeHtml } from '../core/util.js';
import { dbCapabilityPromise } from '../core/store.js';
import { registerBusy } from '../core/busy.js';
import { stocks } from '../core/stocks.js';
import { userRef } from '../identity/session.js';
import { ago, counts, dots, freshness, needs, priorityOrder } from './freshness.js';

const esc = escapeHtml;
const KIND_LABEL = { fund: "Fundamental", tech: "Technical" };
const CHUNK = Math.min(50, LD_BATCH_MAX.fund, LD_BATCH_MAX.tech);   // stocks per engine batch
const CAP = { fund: 300, tech: 1000 };                              // most stocks one press may queue
const CONFIRM_OVER = { fund: 50, tech: 100 };                       // above this the user is asked first
const LS_KEY = "albaDashboard.refreshQueue.v1";
const HEARTBEAT_MS = 15000, TAKEOVER_MS = 45000;
const tabId = Math.random().toString(36).slice(2, 10);

// ---------- keys and lookups ----------
let keyMap = null, keyMapSize = -1;
function stockByKey(key) {
  if (!keyMap || keyMapSize !== stocks.length) { keyMap = new Map(stocks.map((s) => [pcTickerKey(s), s])); keyMapSize = stocks.length; }
  return keyMap.get(key) || null;
}
const sectionOf = (source) => source === "analysis" ? "analysis" : source === "strat" ? "strategies" : /^biz-/.test(source || "") ? "business" : "";

// ---------- scopes, selections ----------
const scopes = new Map();      // id -> { label, source, selName, stocks() }
const toolbars = new Map();    // name -> () => [{ id, label, stocks() }]
const selections = { analysis: new Set(), biz: new Set() };
const external = {};           // name -> () => Set of keys, owned by another module (Strategies keeps its ticked rows)
function defineScope(id, def) { scopes.set(id, def); }
function defineToolbar(name, fn) { toolbars.set(name, fn); }
function useExternalSelection(name, getSet) { external[name] = getSet; }
const selKeys = (name) => external[name] ? external[name]() : (selections[name] || (selections[name] = new Set()));
function scopeStocks(id) {
  const sc = scopes.get(id);
  try { return sc ? sc.stocks().filter(Boolean) : []; } catch (e) { return []; }
}
function selectedStocks(name) { return Array.from(selKeys(name)).map(stockByKey).filter(Boolean); }

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
const refreshLabel = () => isBusy() ? '<i class="rk-spin" aria-hidden="true"></i> Refreshing ▾' : "↻ Refresh ▾";
const jobId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function jobView(j) {
  const b = j === activeJob ? getLdBatch() : null;
  const progressed = b && b.running ? Math.min(j.keys.length, b.done) : 0;
  return { id: j.id, kind: j.kind, keys: j.keys.slice(progressed), total: j.total, done: j.done + progressed, source: j.source, label: j.label, createdAt: j.createdAt };
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
function enqueueJob(kind, list, source, label) {
  const already = queuedKeys(kind);
  const keys = [];
  for (const s of list) { const k = pcTickerKey(s); if (!already.has(k) && !keys.includes(k)) keys.push(k); }
  if (!keys.length) return 0;
  const j = { id: jobId(), kind, keys, total: keys.length, done: 0, source: source || "", label: label || "", createdAt: Date.now(), stats: { refreshed: 0, notRun: 0, failed: [], stopped: false, note: "", perm: false } };
  if (!queue.length) claimedAt = Date.now();
  queue.push(j);
  if (queue.length > 1) queuedItem(j);
  persistNow(); repaint(); pump();
  return keys.length;
}
const engineBusy = () => { const b = getLdBatch(); return !!(b && b.running); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  if (big && !spec.confirmed) { openConfirm(anchor, spec, plan); return; }
  let added = 0;
  for (const p of plan) added += enqueueJob(p.kind, p.list, spec.source, spec.label);
  if (!added) notice({ tone: "ok", title: "Already queued", text: "These stocks are already waiting in the refresh queue or being refreshed.", section: "" });
  if (spec.selName && spec.clearSel && !external[spec.selName]) { selKeys(spec.selName).clear(); syncChecks(); }
  repaint();
}
const kindsOf = (k) => k === "both" ? ["tech", "fund"] : [k];
function specForScope(id, kind, only) {
  const sc = scopes.get(id);
  return sc ? { list: scopeStocks(id), kinds: kindsOf(kind), only: !!only, source: sc.source, label: sc.label, selName: null } : null;
}
function enqueueOne(s, kind) {
  request({ list: [s], kinds: [kind], only: false, source: "detail", label: s.name }, null);
}

// ---------- controls: markup ----------
function sumPart(label, k, n) {
  return k === 0 ? label + " up to date" : label + ": " + k + " of " + n + (k === 1 ? " needs" : " need") + " refresh";
}
function runStatus(source) {
  const j = activeJob, b = getLdBatch();
  const mine = j && j.source === source;
  const waiting = queue.filter((x) => x !== activeJob && x.source === source).length;
  if (mine && b && b.running) {
    const frac = (j.done + Math.min(b.done, b.total)) / j.total;
    return '<span class="rk-run" role="status"><i class="rk-spin" aria-hidden="true"></i>Refreshing ' + KIND_LABEL[j.kind] + " · " + Math.round(Math.min(1, frac) * 100) + "%" + (waiting ? " · " + waiting + " queued" : "") + '</span><button type="button" class="rk-btn rk-stop" data-rk-act="stop">Stop</button>';
  }
  if (waiting) return '<span class="rk-run" role="status">' + waiting + " refresh" + (waiting === 1 ? "" : "es") + " queued</span>";
  return "";
}
function barInner(id) {
  const sc = scopes.get(id);
  if (!sc) return "";
  const list = scopeStocks(id), c = counts(list), off = list.length ? "" : " disabled";
  return '<button type="button" class="rk-btn rk-main rk-barbtn" data-rk-act="bar-menu" data-rk-scope="' + esc(id) + '"' + off + ' aria-haspopup="menu" data-rk-busy="' + (isBusy() ? "1" : "0") + '" title="Refresh Fundamental and Technical info for ' + list.length + ' stock' + (list.length === 1 ? "" : "s") + '">' + refreshLabel() + '</button>'  + runStatus(sc.source);
}
function barHtml(id) {
  return '<span class="rk-bar" data-rk-bar="' + esc(id) + '">' + barInner(id) + "</span>";
}
function headCell(selName, scopeId) {
  return "";  // no checkbox column on Analysis and Explorer: it had nothing to do there

  return '<th class="rk-cell"><input type="checkbox" class="rk-chk-all" data-rk-sel="' + esc(selName) + '" data-rk-scope="' + esc(scopeId) + '" aria-label="Select every row in this table for refresh"></th>';
}
function rowButton(s, selName) {
  return "";  // per-row refresh button removed from the grids
  return '<button type="button" class="rk-row-btn" data-rk-row="' + esc(pcTickerKey(s)) + '" data-rk-sel="' + esc(selName) + '" aria-haspopup="menu" aria-label="Refresh ' + esc(s.name) + '" title="Refresh this stock">↻</button>';
}
function rowBtn(s, selName) { return rowButton(s, selName); }
const choices = new Map();     // id -> () => { head, note, items: [{ label, small, off, run }] }
function defineChoices(id, fn) { choices.set(id, fn); }
function choiceBtn(id, off, title) {
  return '<button type="button" class="rk-btn rk-main rk-choicebtn biz-newsbtn" data-rk-act="choice" data-rk-cid="' + esc(id) + '"' + (off ? " disabled" : "") + ' aria-haspopup="menu" data-rk-busy="' + (isBusy() ? "1" : "0") + '" title="' + esc(title || "Refresh") + '">' + refreshLabel() + '</button>';
}
function choiceMenuHtml(id) {
  let c; try { c = choices.get(id)(); } catch (e) { c = null; }
  if (!c) return "";
  menuChoices = c.items;
  return (c.head ? '<div class="rk-menu-head">' + esc(c.head) + "</div>" : "") + (c.note ? '<p class="rk-menu-note">' + esc(c.note) + "</p>" : "") +
    c.items.map((it, i) => item("choice-run", 'data-rk-i="' + i + '"', esc(it.label), it.small ? esc(it.small) : "", it.off)).join("");
}
let menuChoices = [];
function stockBtn(s) {
  return '<button type="button" class="rk-row-btn rk-stockbtn" data-rk-row="' + esc(pcTickerKey(s)) + '" data-rk-sel="stock" aria-haspopup="menu" title="Refresh Fundamental or Technical info for this stock">↻ Refresh ▾</button>';
}
function rowCell(s, selName) {
  return "";  // no checkbox column on Analysis and Explorer: it had nothing to do there

  const key = pcTickerKey(s), on = selKeys(selName).has(key);
  return '<td class="rk-cell"><input type="checkbox" class="rk-chk" data-rk-key="' + esc(key) + '" data-rk-sel="' + esc(selName) + '"' + (on ? " checked" : "") + ' aria-label="Select ' + esc(s.name) + ' for refresh">' + rowButton(s, selName) + "</td>";
}
function selbarInner(name) {
  const n = selKeys(name).size;
  if (!n) return "";
  const b = (kind, label) => '<button type="button" class="rk-btn" data-rk-act="sel-run" data-rk-kind="' + kind + '" data-rk-sel="' + esc(name) + '">' + label + "</button>";
  return '<div class="rk-selbar" role="region" aria-label="Selected stocks"><span class="rk-selcount">' + n + " selected</span>" + b("fund", "↻ Fundamental") + b("tech", "↻ Technical") + b("both", "↻ Both") + '<button type="button" class="rk-btn rk-clear" data-rk-act="sel-clear" data-rk-sel="' + esc(name) + '">Clear</button></div>';
}
function selbarSlot(name) { return '<div class="rk-selslot" data-rk-selbar="' + esc(name) + '">' + selbarInner(name) + "</div>"; }
function toolbarButton(name) {
  return '<button type="button" class="biz-expand rk-toolbtn" data-rk-act="toolbar" data-rk-tb="' + esc(name) + '" aria-haspopup="menu" data-rk-busy="' + (isBusy() ? "1" : "0") + '" title="Refresh Fundamental or Technical info for many stocks at once">' + refreshLabel() + '</button>';
}

// ---------- repaint ----------
let paintQueued = false;
function repaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    document.querySelectorAll("[data-rk-bar]").forEach((el) => {
      const html = barInner(el.dataset.rkBar);
      if (el.__rk !== html) { el.__rk = html; el.innerHTML = html; }
    });
    document.querySelectorAll("[data-rk-selbar]").forEach((el) => {
      const html = selbarInner(el.dataset.rkSelbar);
      if (el.__rk !== html) { el.__rk = html; el.innerHTML = html; }
    });
    const busy = isBusy() ? "1" : "0";
    document.querySelectorAll(".rk-toolbtn,.rk-choicebtn,.rk-barbtn").forEach((b) => {
      if (b.dataset.rkBusy === busy) return;
      b.dataset.rkBusy = busy; b.innerHTML = refreshLabel();
    });
    if (activeJob) persistSoon();
  });
}
function syncChecks() {
  document.querySelectorAll(".rk-chk").forEach((c) => { c.checked = selKeys(c.dataset.rkSel).has(c.dataset.rkKey); });
  document.querySelectorAll(".rk-chk-all").forEach((c) => {
    const keys = scopeStocks(c.dataset.rkScope).map(pcTickerKey), set = selKeys(c.dataset.rkSel);
    const n = keys.filter((k) => set.has(k)).length;
    c.checked = keys.length > 0 && n === keys.length;
    c.indeterminate = n > 0 && n < keys.length;
  });
  repaint();
}
function selectionChanged() { syncChecks(); }

// ---------- the floating menu ----------
let menuEl = null, menuAnchor = null, menuState = null;
function closeMenu(focusBack) {
  if (!menuEl) return;
  menuEl.remove();
  const a = menuAnchor;
  menuEl = null; menuAnchor = null; menuState = null;
  if (a) a.setAttribute("aria-expanded", "false");
  if (focusBack && a && a.isConnected) a.focus();
}
function placeMenu() {
  if (!menuEl) return;
  const m0 = menuEl.getBoundingClientRect();
  if (!menuAnchor || !menuAnchor.isConnected) {
    menuEl.style.left = Math.max(8, (window.innerWidth - m0.width) / 2) + "px"; menuEl.style.top = Math.max(8, (window.innerHeight - m0.height) / 3) + "px";
    return;
  }
  const r = menuAnchor.getBoundingClientRect(), m = m0;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - m.width - 8));
  let top = r.bottom + 6;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 6);
  menuEl.style.left = left + "px"; menuEl.style.top = top + "px";
}
function openMenu(anchor, html, state) {
  closeMenu(false);
  menuEl = document.createElement("div");
  menuEl.className = "rk-menu"; menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = html;
  document.body.appendChild(menuEl);
  menuAnchor = anchor; menuState = state || {};
  if (anchor) anchor.setAttribute("aria-expanded", "true");
  placeMenu();
  const first = menuEl.querySelector("button:not(:disabled), input");
  if (first) first.focus();
}
function refillMenu(html) {
  if (!menuEl) return;
  menuEl.innerHTML = html; placeMenu();
}
const item = (act, attrs, label, small, off) => '<button type="button" role="menuitem" class="rk-item" data-rk-act="' + act + '" ' + attrs + (off ? " disabled" : "") + ">" + label + (small ? "<small>" + small + "</small>" : "") + "</button>";

function barMenuHtml(id) {
  const sc = scopes.get(id), list = scopeStocks(id), c = counts(list), n = list.length;
  const a = 'data-rk-scope="' + esc(id) + '"';
  return '<div class="rk-menu-head">' + esc(sc.label) + " · " + n + " stock" + (n === 1 ? "" : "s") + "</div>" +
    '<p class="rk-menu-note">' + (n ? sumPart("Fundamental", c.fund, c.n) + ".<br>" + sumPart("Technical", c.tech, c.n) + "." + (c.attn ? "<br>" + c.attn + " with new results, news or a big price move." : "") : "Nothing here to refresh.") + "</p>" +
    item("menu-run", a + ' data-rk-kind="fund" data-rk-only="0"', "↻ Fundamental", "all " + n, !n) +
    item("menu-run", a + ' data-rk-kind="tech" data-rk-only="0"', "↻ Technical", "all " + n, !n) +
    item("menu-run", a + ' data-rk-kind="both" data-rk-only="0"', "↻ Both", "all " + n, !n) +
    '<div class="rk-menu-head">Only what is out of date</div>' +
    item("menu-run", a + ' data-rk-kind="fund" data-rk-only="1"', "↻ Fundamental", c.fund + " stock" + (c.fund === 1 ? "" : "s"), !c.fund) +
    item("menu-run", a + ' data-rk-kind="tech" data-rk-only="1"', "↻ Technical", c.tech + " stock" + (c.tech === 1 ? "" : "s"), !c.tech) +
    item("menu-run", a + ' data-rk-kind="both" data-rk-only="1"', "↻ Both", "only those that need it", !(c.fund || c.tech));
}
function rowMenuHtml(key, selName) {
  const s = stockByKey(key), f = s ? freshness(s) : null;
  const a = 'data-rk-key="' + esc(key) + '" data-rk-sel="' + esc(selName) + '"';
  return '<div class="rk-menu-head">' + esc(s ? s.name : key) + "</div>" +
    item("row-run", a + ' data-rk-kind="fund"', "↻ Fundamental", f ? (f.fund.age === null ? "not researched yet" : "researched " + ago(f.fund.age) + (f.why.length ? " · " + f.why.join(", ") : "")) : "") +
    item("row-run", a + ' data-rk-kind="tech"', "↻ Technical", f ? (f.tech.age === null ? "no price date" : "price as of " + ago(f.tech.age)) : "") +
    item("row-run", a + ' data-rk-kind="both"', "↻ Both", "");
}
function toolbarChoices(name) {
  try { return (toolbars.get(name) || (() => []))(); } catch (e) { return []; }
}
function toolbarMenuHtml(name, st) {
  const choices = toolbarChoices(name).map((c) => Object.assign({}, c, { list: c.stocks().filter(Boolean) }));
  if (!st.choice || !choices.some((c) => c.id === st.choice && c.list.length)) { const first = choices.find((c) => c.list.length); st.choice = first ? first.id : (choices[0] ? choices[0].id : ""); }
  const cur = choices.find((c) => c.id === st.choice), list = cur ? cur.list : [], c = counts(list);
  const radios = choices.map((x) => '<label class="rk-radio' + (x.list.length ? "" : " off") + '"><input type="radio" name="rkscope" value="' + esc(x.id) + '"' + (x.id === st.choice ? " checked" : "") + (x.list.length ? "" : " disabled") + "> " + esc(x.label) + ' <span class="rk-n">' + x.list.length + "</span></label>").join("");
  const a = 'data-rk-tb="' + esc(name) + '"';
  return '<div class="rk-menu-head">Refresh stocks</div><div class="rk-scopes" role="radiogroup" aria-label="Which stocks">' + radios + '</div>' +
    '<label class="rk-only"><input type="checkbox" id="rkOnly"' + (st.only ? " checked" : "") + "> Only those that need a refresh</label>" +
    '<div class="rk-menu-actions">' + ["fund", "tech", "both"].map((k) => '<button type="button" class="rk-btn" data-rk-act="tb-run" ' + a + ' data-rk-kind="' + k + '"' + (list.length ? "" : " disabled") + ">↻ " + (k === "both" ? "Both" : KIND_LABEL[k]) + "</button>").join("") + "</div>" +
    '<div class="rk-menu-note">' + (list.length ? sumPart("Fundamental", c.fund, c.n) + " · " + sumPart("Technical", c.tech, c.n) + "." : "Nothing to refresh in this choice.") + "</div>";
}
function openConfirm(anchor, spec, plan) {
  const lines = plan.map((p) => KIND_LABEL[p.kind] + ": " + p.list.length + " stocks").join(" · ");
  const usesClaude = plan.some((p) => p.kind === "fund");
  const html = '<div class="rk-menu-head">Refresh this many stocks?</div><p class="rk-menu-note">' + esc(lines) + ". It runs in batches of " + CHUNK + (usesClaude ? " and Fundamental uses your Claude usage" : "") + ". If you close this page it carries on when you reopen the dashboard.</p>" +
    '<div class="rk-menu-actions"><button type="button" class="rk-btn rk-go" data-rk-act="confirm-run">Start</button><button type="button" class="rk-btn" data-rk-act="close">Cancel</button></div>';
  openMenu(anchor, html, { pending: Object.assign({}, spec, { confirmed: true }) });
}

// ---------- events ----------
let wired = false;
function onClick(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  const row = t.closest(".rk-row-btn");
  if (row) {
    e.stopPropagation();                 // the refresh icon must not open the stock
    if (menuEl && menuAnchor === row) closeMenu(false);
    else openMenu(row, rowMenuHtml(row.dataset.rkRow, row.dataset.rkSel), { type: "row" });
    return;
  }
  if (t.closest(".rk-cell")) { e.stopPropagation(); return; }   // nor must a click on the checkbox
  const act = t.closest("[data-rk-act]");
  if (!act) { if (menuEl && !t.closest(".rk-menu")) closeMenu(false); return; }
  e.stopPropagation();
  const a = act.dataset.rkAct;
  if (a === "close") { closeMenu(true); return; }
  if (a === "stop") { ldBatchStop(); return; }
  if (a === "run") { const spec = specForScope(act.dataset.rkScope, act.dataset.rkKind, false); if (spec) request(spec, act); return; }
  if (a === "choice") { if (menuEl && menuAnchor === act) { closeMenu(false); return; } openMenu(act, choiceMenuHtml(act.dataset.rkCid), { type: "choice" }); return; }
  if (a === "choice-run") { const it = menuChoices[Number(act.dataset.rkI)]; closeMenu(false); if (it && it.run) it.run(); return; }
  if (a === "bar-menu") { if (menuEl && menuAnchor === act) { closeMenu(false); return; } openMenu(act, barMenuHtml(act.dataset.rkScope), { type: "bar" }); return; }
  if (a === "menu-run") { const spec = specForScope(act.dataset.rkScope, act.dataset.rkKind, act.dataset.rkOnly === "1"); const anchor = menuAnchor; closeMenu(false); if (spec) request(spec, anchor); return; }
  if (a === "row-run") {
    const s = stockByKey(act.dataset.rkKey), anchor = menuAnchor; closeMenu(false);
    if (s) request({ list: [s], kinds: kindsOf(act.dataset.rkKind), only: false, source: sourceForSel(act.dataset.rkSel), label: s.name }, anchor);
    return;
  }
  if (a === "sel-run") {
    const name = act.dataset.rkSel, list = selectedStocks(name);
    request({ list, kinds: kindsOf(act.dataset.rkKind), only: false, source: sourceForSel(name), label: list.length + " selected", selName: name, clearSel: true }, act);
    return;
  }
  if (a === "sel-clear") { const name = act.dataset.rkSel; if (external[name]) { document.dispatchEvent(new CustomEvent("alba-rk-clear", { detail: { name } })); } else selKeys(name).clear(); syncChecks(); return; }
  if (a === "toolbar") {
    if (menuEl && menuAnchor === act) { closeMenu(false); return; }
    const st = toolbarState[act.dataset.rkTb] || (toolbarState[act.dataset.rkTb] = { choice: "", only: false });
    openMenu(act, toolbarMenuHtml(act.dataset.rkTb, st), { type: "toolbar", name: act.dataset.rkTb });
    return;
  }
  if (a === "tb-run") {
    const name = act.dataset.rkTb, st = toolbarState[name], cur = toolbarChoices(name).find((c) => c.id === st.choice);
    const anchor = menuAnchor; closeMenu(false);
    if (cur) request({ list: cur.stocks().filter(Boolean), kinds: kindsOf(act.dataset.rkKind), only: !!st.only, source: sourceForSel(name), label: cur.label }, anchor);
    return;
  }
  if (a === "confirm-run") { const spec = menuState && menuState.pending; closeMenu(false); if (spec) request(spec, null); return; }
}
const toolbarState = {};
const sourceForSel = (name) => name === "analysis" ? "analysis" : name === "strat" ? "strat" : name === "biz" ? "biz-kit" : "detail";
function onChange(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.classList.contains("rk-chk")) {
    e.stopPropagation();
    const set = selKeys(t.dataset.rkSel);
    t.checked ? set.add(t.dataset.rkKey) : set.delete(t.dataset.rkKey);
    syncChecks();
    return;
  }
  if (t.classList.contains("rk-chk-all")) {
    e.stopPropagation();
    const set = selKeys(t.dataset.rkSel), keys = scopeStocks(t.dataset.rkScope).map(pcTickerKey);
    keys.forEach((k) => t.checked ? set.add(k) : set.delete(k));
    syncChecks();
    return;
  }
  if (menuEl && menuState && menuState.type === "toolbar" && t.closest(".rk-menu")) {
    const st = toolbarState[menuState.name];
    if (t.name === "rkscope") st.choice = t.value;
    else if (t.id === "rkOnly") st.only = t.checked;
    else return;
    refillMenu(toolbarMenuHtml(menuState.name, st));
    const again = menuEl.querySelector(t.id === "rkOnly" ? "#rkOnly" : 'input[name="rkscope"]:checked');
    if (again) again.focus();
  }
}
function onKeydown(e) {
  const t = e.target;
  if (t && t.closest && t.closest(".rk-cell, .rk-row-btn")) {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();    // not "open this stock"
  }
  if (!menuEl) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const items = Array.from(menuEl.querySelectorAll("button:not(:disabled), input:not(:disabled)"));
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  }
}
function installListeners() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("mousedown", (e) => { if (menuEl && !e.target.closest(".rk-menu") && !e.target.closest("[data-rk-act]") && !e.target.closest(".rk-row-btn")) closeMenu(false); }, true);
  window.addEventListener("scroll", (e) => { if (menuEl && !(e.target && e.target.closest && e.target.closest(".rk-menu"))) closeMenu(false); }, true);
  window.addEventListener("resize", () => closeMenu(false));
  window.addEventListener("pagehide", () => { if (queue.length) writeNow(); });
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
export async function init() {
  installListeners();
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

export const kit = { choiceBtn, defineChoices, stockBtn, dots, barHtml, headCell, rowCell, rowBtn, selbarSlot, toolbarButton, defineScope, defineToolbar, useExternalSelection, selectionChanged, repaint, activity, batchNotice, enqueueOne };
