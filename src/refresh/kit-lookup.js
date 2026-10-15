// Refresh kit: how stocks are looked up by key, and the registries the controls read (scopes, toolbars, selections).
import { pcTickerKey } from '../prices/store.js';
import { stocks } from '../core/stocks.js';

let keyMap = null, keyMapSize = -1;
function stockByKey(key) {
  if (!keyMap || keyMapSize !== stocks.length) { keyMap = new Map(stocks.map((s) => [pcTickerKey(s), s])); keyMapSize = stocks.length; }
  return keyMap.get(key) || null;
}
const sectionOf = (source) => source === "analysis" ? "analysis" : source === "strat" ? "strategies" : /^biz-/.test(source || "") ? "business" : "";

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
const getScope = (id) => scopes.get(id);
const getToolbar = (name) => toolbars.get(name);
const isExternalSelection = (name) => !!external[name];

export { defineScope, defineToolbar, getScope, getToolbar, isExternalSelection, scopeStocks, sectionOf, selKeys, selectedStocks, stockByKey, useExternalSelection };
