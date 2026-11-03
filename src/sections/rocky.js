// The Rocky page: the paper-trading swing agent's ledger, picks and learning. Loads the first time the page is opened (see core/lazy.js).
import { rockyHtml } from '../rocky/render.js';
import { startRockySync } from '../rocky/store.js';
import { setHtml } from '../core/safehtml.js';

const body = () => document.getElementById('rockyBody');

function render(){
  const el = body(); if(!el) return;
  setHtml(el, rockyHtml());
}

function init(){
  startRockySync(true);
  render();
}

export { init, render };
