// What a factor card shows from its saved research: the bullets (with their source tags and the numbers that tie them to metric
// rows) and the extra figure rows. Old research saved before v1.299 has plain-text bullets: those show without tags.
import { BASIS_LABEL, dropRepeats } from '../core/sourcetags.js';

function pointsView(f) {
  const r = (f && f.research) || {}, nums = new Map(), raw = [];
  (Array.isArray(r.points) ? r.points : []).forEach(x => {
    const p = typeof x === 'string' ? { text: x } : x;
    if (!p || typeof p.text !== 'string' || !p.text) return;
    raw.push({ text: p.text, tags: Array.isArray(p.basis) ? p.basis.filter(b => BASIS_LABEL[b]) : [], ok: p.ok !== false, url: /^https?:\/\//.test(p.url || '') ? p.url : '', src: p.src || '', refs: Array.isArray(p.refs) ? p.refs : [] });
  });
  // v1.303: numbers are given only to the bullets that are actually shown (a repeated sentence is shown once), so every number on a row has a bullet to match.
  let n = 0;
  const pts = dropRepeats(raw, []).map(({ refs, ...q }) => {
    if (refs.length) {
      q.n = ++n;
      refs.forEach(l => nums.set(l, (nums.get(l) || []).concat(q.n)));
    }
    return q;
  });
  // Copies: the saved research is read-only, so a row is never changed in place.
  const facts = (Array.isArray(r.facts) ? r.facts : []).filter(x => x && x.label && x.value).map(x => ({ ...x, n: nums.get(x.label) || [] }));
  return { pts, nums, facts };
}

export { pointsView };
