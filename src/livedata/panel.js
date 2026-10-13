// Markup shared by the Live Data Refresh cards of the Analysis, Strategies and Explorer screens (the stock page draws its own
// in bar.js). `P` is the screen's id prefix ('analysis', 'strat' or 'biz-N'). Buttons, progress bars and result lines are
// filled in by ldBatchPaint() (batch.js); the screen supplies the label and hint of each card with ldSetCard().

// Each press refreshes the next batch of a screen's stocks, in the order listed: the first press does the first batch, the next the following
// one, then it starts again from the top. The place is kept per kind and starts over when `key` (a signature of the list) changes.
function createBatchRounds(max = { fund: 50, tech: 50 }){
  const next = { fund: 0, tech: 0 }, sig = { fund: '', tech: '' };
  function plan(kind, list, key){
    const all = list.length;
    if(sig[kind] !== key){ sig[kind] = key; next[kind] = 0; }
    if(next[kind] >= all) next[kind] = 0;
    const from = next[kind], batch = list.slice(from, from + max[kind]);
    return { list: batch, from, to: from + batch.length, all };
  }
  // Called when a card's button is pressed: returns that batch and moves on to the following one.
  function take(kind, list, key){
    const p = plan(kind, list, key);
    next[kind] = p.to >= p.all ? 0 : p.to;
    return p.list;
  }
  return { plan, take };
}

export { createBatchRounds };
