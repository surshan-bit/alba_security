// Refresh kit: the controls. The Refresh buttons in a table's header line, the menus they open (a stock's menu, the Explorer toolbar
// menu, the "bar" menu), the row ticks and selection bar, and the keyboard and click handling. Running a refresh goes through
// kit-queue.js (request), the floating menu itself is kit-menu.js and the registries of scopes and selections are kit-lookup.js.
import { getLdBatch, ldBatchStop } from '../livedata/batch.js';
import { pcTickerKey } from '../prices/store.js';
import { escapeHtml } from '../core/util.js';
import { ago, counts, freshness } from './freshness.js';
import { closestEl } from '../core/evt.js';
import { getScope, getToolbar, isExternalSelection, scopeStocks, sectionOf, selKeys, selectedStocks, stockByKey } from './kit-lookup.js';
import { closeMenu, getMenuAnchor, getMenuState, item, menuIsOpen, menuOpenAt, menuQuery, menuQueryAll, openMenu, refillMenu } from './kit-menu.js';
import { CHUNK, KIND_LABEL, busyIn, flushQueue, getActiveJob, persistIfRunning, queuedJobs, request, setQueueHooks } from './kit-queue.js';

const esc = escapeHtml;
// Only the screen that started the refresh shows the spinner; the other screens keep a normal Refresh button.
const refreshLabel = (sec) => busyIn(sec) ? '<i class="rk-spin" aria-hidden="true"></i> Refreshing ▾' : "↻ Refresh ▾";

const kindsOf = (k) => k === "both" ? ["tech", "fund"] : [k];
function specForScope(id, kind, only) {
  const sc = getScope(id);
  return sc ? { list: scopeStocks(id), kinds: kindsOf(kind), only: !!only, source: sc.source, label: sc.label, selName: null } : null;
}
// ---------- controls: markup ----------
function sumPart(label, k, n) {
  return k === 0 ? label + " up to date" : label + ": " + k + " of " + n + (k === 1 ? " needs" : " need") + " refresh";
}
function runStatus(source) {
  const j = getActiveJob(), b = getLdBatch();
  const mine = j && j.source === source;
  const waiting = queuedJobs().filter((x) => x !== j && x.source === source).length;
  if (mine && b && b.running) {
    const frac = (j.done + Math.min(b.done, b.total)) / j.total;
    return '<span class="rk-run" role="status"><i class="rk-spin" aria-hidden="true"></i>Refreshing ' + KIND_LABEL[j.kind] + " · " + Math.round(Math.min(1, frac) * 100) + "%" + (waiting ? " · " + waiting + " queued" : "") + '</span><button type="button" class="rk-btn rk-stop" data-rk-act="stop">Stop</button>';
  }
  if (waiting) return '<span class="rk-run" role="status">' + waiting + " refresh" + (waiting === 1 ? "" : "es") + " queued</span>";
  return "";
}
function barInner(id) {
  const sc = getScope(id);
  if (!sc) return "";
  const list = scopeStocks(id), c = counts(list), off = list.length ? "" : " disabled";
  return '<button type="button" class="rk-btn rk-main rk-barbtn" data-rk-act="bar-menu" data-rk-scope="' + esc(id) + '"' + off + ' aria-haspopup="menu" data-rk-busy="' + (busyIn(sectionOf(sc.source)) ? "1" : "0") + '" title="Refresh Fundamental and Technical info for ' + list.length + ' stock' + (list.length === 1 ? "" : "s") + '">' + refreshLabel(sectionOf(sc.source)) + '</button>'  + runStatus(sc.source);
}
function barHtml(id) {
  return '<span class="rk-bar" data-rk-bar="' + esc(id) + '">' + barInner(id) + "</span>";
}
function headCell() { return ""; }   // no checkbox column on Analysis and Explorer: it had nothing to do there
function rowBtn() { return ""; }     // no per-row refresh button in the grids
const choices = new Map();     // id -> () => { head, note, items: [{ label, small, off, run }] }
function defineChoices(id, fn) { choices.set(id, fn); }
function choiceBtn(id, off, title) {
  return '<button type="button" class="rk-btn rk-main rk-choicebtn biz-newsbtn" data-rk-act="choice" data-rk-cid="' + esc(id) + '"' + (off ? " disabled" : "") + ' aria-haspopup="menu" data-rk-busy="' + (busyIn("business") ? "1" : "0") + '" title="' + esc(title || "Refresh") + '">' + refreshLabel("business") + '</button>';
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
function rowCell() { return ""; }   // no checkbox column on Analysis and Explorer: it had nothing to do there
function selbarInner(name) {
  const n = selKeys(name).size;
  if (!n) return "";
  const b = (kind, label) => '<button type="button" class="rk-btn" data-rk-act="sel-run" data-rk-kind="' + kind + '" data-rk-sel="' + esc(name) + '">' + label + "</button>";
  return '<div class="rk-selbar" role="region" aria-label="Selected stocks"><span class="rk-selcount">' + n + " selected</span>" + b("fund", "↻ Fundamental") + b("tech", "↻ Technical") + b("both", "↻ Both") + '<button type="button" class="rk-btn rk-clear" data-rk-act="sel-clear" data-rk-sel="' + esc(name) + '">Clear</button></div>';
}
function selbarSlot(name) { return '<div class="rk-selslot" data-rk-selbar="' + esc(name) + '">' + selbarInner(name) + "</div>"; }
function toolbarButton(name) {
  return '<button type="button" class="biz-expand rk-toolbtn" data-rk-act="toolbar" data-rk-tb="' + esc(name) + '" aria-haspopup="menu" data-rk-busy="' + (busyIn("business") ? "1" : "0") + '" title="Refresh Fundamental or Technical info for many stocks at once">' + refreshLabel("business") + '</button>';
}

// ---------- repaint ----------
let paintQueued = false;
function repaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    document.querySelectorAll("[data-rk-bar]").forEach((el) => {
      const html = barInner(/** @type {HTMLElement} */ (el).dataset.rkBar);
      if (/** @type {any} */ (el).__rk !== html) { /** @type {any} */ (el).__rk = html; el.innerHTML = html; }
    });
    document.querySelectorAll("[data-rk-selbar]").forEach((el) => {
      const html = selbarInner(/** @type {HTMLElement} */ (el).dataset.rkSelbar);
      if (/** @type {any} */ (el).__rk !== html) { /** @type {any} */ (el).__rk = html; el.innerHTML = html; }
    });
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".rk-toolbtn,.rk-choicebtn,.rk-barbtn")).forEach((b) => {
      const sc = b.dataset.rkScope ? getScope(b.dataset.rkScope) : null, sec = sc ? sectionOf(sc.source) : "business";
      const busy = busyIn(sec) ? "1" : "0";
      if (b.dataset.rkBusy === busy) return;
      b.dataset.rkBusy = busy; b.innerHTML = refreshLabel(sec);
    });
    persistIfRunning();
  });
}
function syncChecks() {
  document.querySelectorAll(".rk-chk").forEach((c) => { /** @type {HTMLInputElement} */ (c).checked = selKeys(/** @type {HTMLElement} */ (c).dataset.rkSel).has(/** @type {HTMLElement} */ (c).dataset.rkKey); });
  document.querySelectorAll(".rk-chk-all").forEach((c) => {
    const keys = scopeStocks(/** @type {HTMLElement} */ (c).dataset.rkScope).map(pcTickerKey), set = selKeys(/** @type {HTMLElement} */ (c).dataset.rkSel);
    const n = keys.filter((k) => set.has(k)).length;
    /** @type {HTMLInputElement} */ (c).checked = keys.length > 0 && n === keys.length;
    /** @type {HTMLInputElement} */ (c).indeterminate = n > 0 && n < keys.length;
  });
  repaint();
}
function selectionChanged() { syncChecks(); }


function barMenuHtml(id) {
  const sc = getScope(id), list = scopeStocks(id), c = counts(list), n = list.length;
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
  try { return (getToolbar(name) || (() => []))(); } catch (e) { return []; }
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
    if (menuOpenAt(row)) closeMenu(false);
    else openMenu(row, rowMenuHtml(row.dataset.rkRow, row.dataset.rkSel), { type: "row" });
    return;
  }
  if (t.closest(".rk-cell")) { e.stopPropagation(); return; }   // nor must a click on the checkbox
  const act = t.closest("[data-rk-act]");
  if (!act) { if (menuIsOpen() && !t.closest(".rk-menu")) closeMenu(false); return; }
  e.stopPropagation();
  const a = act.dataset.rkAct;
  if (a === "close") { closeMenu(true); return; }
  if (a === "stop") { ldBatchStop(); return; }
  if (a === "run") { const spec = specForScope(act.dataset.rkScope, act.dataset.rkKind, false); if (spec) request(spec, act); return; }
  if (a === "choice") { if (menuOpenAt(act)) { closeMenu(false); return; } openMenu(act, choiceMenuHtml(act.dataset.rkCid), { type: "choice" }); return; }
  if (a === "choice-run") { const it = menuChoices[Number(act.dataset.rkI)]; closeMenu(false); if (it && it.run) it.run(); return; }
  if (a === "bar-menu") { if (menuOpenAt(act)) { closeMenu(false); return; } openMenu(act, barMenuHtml(act.dataset.rkScope), { type: "bar" }); return; }
  if (a === "menu-run") { const spec = specForScope(act.dataset.rkScope, act.dataset.rkKind, act.dataset.rkOnly === "1"); const anchor = getMenuAnchor(); closeMenu(false); if (spec) request(spec, anchor); return; }
  if (a === "row-run") {
    const s = stockByKey(act.dataset.rkKey), anchor = getMenuAnchor(); closeMenu(false);
    if (s) request({ list: [s], kinds: kindsOf(act.dataset.rkKind), only: false, source: sourceForSel(act.dataset.rkSel), label: s.name }, anchor);
    return;
  }
  if (a === "sel-run") {
    const name = act.dataset.rkSel, list = selectedStocks(name);
    request({ list, kinds: kindsOf(act.dataset.rkKind), only: false, source: sourceForSel(name), label: list.length + " selected", selName: name, clearSel: true }, act);
    return;
  }
  if (a === "sel-clear") { const name = act.dataset.rkSel; if (isExternalSelection(name)) { document.dispatchEvent(new CustomEvent("alba-rk-clear", { detail: { name } })); } else selKeys(name).clear(); syncChecks(); return; }
  if (a === "toolbar") {
    if (menuOpenAt(act)) { closeMenu(false); return; }
    const st = toolbarState[act.dataset.rkTb] || (toolbarState[act.dataset.rkTb] = { choice: "", only: false });
    openMenu(act, toolbarMenuHtml(act.dataset.rkTb, st), { type: "toolbar", name: act.dataset.rkTb });
    return;
  }
  if (a === "tb-run") {
    const name = act.dataset.rkTb, st = toolbarState[name], cur = toolbarChoices(name).find((c) => c.id === st.choice);
    const anchor = getMenuAnchor(); closeMenu(false);
    if (cur) request({ list: cur.stocks().filter(Boolean), kinds: kindsOf(act.dataset.rkKind), only: !!st.only, source: sourceForSel(name), label: cur.label }, anchor);
    return;
  }
  if (a === "confirm-run") { const spec = getMenuState() && getMenuState().pending; closeMenu(false); if (spec) request(spec, null); return; }
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
  if (menuIsOpen() && getMenuState() && getMenuState().type === "toolbar" && t.closest(".rk-menu")) {
    const st = toolbarState[getMenuState().name];
    if (t.name === "rkscope") st.choice = t.value;
    else if (t.id === "rkOnly") st.only = t.checked;
    else return;
    refillMenu(toolbarMenuHtml(getMenuState().name, st));
    const again = menuQuery(t.id === "rkOnly" ? "#rkOnly" : 'input[name="rkscope"]:checked');
    if (again) again.focus();
  }
}
function onKeydown(e) {
  const t = e.target;
  if (t && t.closest && t.closest(".rk-cell, .rk-row-btn")) {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();    // not "open this stock"
  }
  if (!menuIsOpen()) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const items = menuQueryAll("button:not(:disabled), input:not(:disabled)");
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
  document.addEventListener("mousedown", (e) => { if (menuIsOpen() && !closestEl(e, ".rk-menu") && !closestEl(e, "[data-rk-act]") && !closestEl(e, ".rk-row-btn")) closeMenu(false); }, true);
  window.addEventListener("scroll", (e) => { if (menuIsOpen() && !(e.target && /** @type {Element} */ (e.target).closest && closestEl(e, ".rk-menu"))) closeMenu(false); }, true);
  window.addEventListener("resize", () => closeMenu(false));
  window.addEventListener("pagehide", flushQueue);
}

// Wires the controls to the queue: what the queue calls to redraw the buttons, update the ticks and open the confirmation.
function installControls() {
  setQueueHooks({ repaint, syncChecks, openConfirm });
  installListeners();
}

export { barHtml, choiceBtn, defineChoices, headCell, installControls, repaint, rowBtn, rowCell, selbarSlot, selectionChanged, stockBtn, toolbarButton };
