// Markup shared by the Live Data Refresh cards of the Analysis, Strategies and Explorer screens (the stock page draws its own
// in bar.js). `P` is the screen's id prefix ('analysis', 'strat' or 'biz-N'). Buttons, progress bars and result lines are
// filled in by ldBatchPaint() (batch.js); the screen supplies the label and hint of each card with ldSetCard().
import { LD_LABEL } from './bar.js';
import { LD_BATCH_MAX, ldBatchPaint, ldSetCard } from './batch.js';

// One shared cursor per screen and kind: each press of a card refreshes the next batch of the list the screen shows (ranks 1-50, then
// 51-100 and so on, then it starts again from the top). The place starts over when `key` changes (the number of stocks or the sort).
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

const cardTitle = (kind, noun) => kind === 'fund'
  ? 'Fills missing metrics, re-scores Moat and Governance, and refreshes Global & Macro, critical news and Strengths for the ' + noun + ' in the order listed. Each press does the next ' + LD_BATCH_MAX.fund + ' stocks. It uses your Claude usage.'
  : 'Pulls the current price from TradingView, recomputes Margin of Safety, fetches new weekly and monthly bars, and recomputes MACD, RSI and the Technical Score for the ' + noun + ' in the order listed. Each press does the next ' + LD_BATCH_MAX.tech + ' stocks.';

// What each card of screen `source` says and allows while nothing is running; called whenever the listed stocks change.
// `noun` names the list ("shown stocks", "picks", "stocks").
function paintBatchCards(source, rounds, list, key, noun){
  for(const kind of ['fund', 'tech']){
    const p = rounds.plan(kind, list, key), max = LD_BATCH_MAX[kind], L = LD_LABEL[kind];
    ldSetCard(source, kind, {
      label: !p.all ? L : p.all <= max ? L + ' (all ' + p.all + ')' : L + ' (' + (p.from + 1) + '–' + p.to + ' of ' + p.all + ')',
      off: !p.list.length, title: cardTitle(kind, noun),
      idle: !p.all ? 'No stocks shown.' : p.all <= max ? 'Refreshes the ' + p.all + ' ' + noun + ' in the order listed.' : 'Refreshes ' + max + ' stocks at a time, in the order listed: ranks ' + (p.from + 1) + ' to ' + p.to + ' next, then the following batch.'
    });
  }
  ldBatchPaint();
}

// The cards, Fundamental then Technical: only the kinds that `btnIds` gives a button id for.
function liveCardsHtml(P, btnIds){
  const card = (kind) => `
        <div class="live-refresh-item" id="${P}Card-${kind}" data-kind="${kind}">
          <div class="live-refresh-actions">
            <button type="button" class="refresh-btn" id="${btnIds[kind]}">${LD_LABEL[kind]}</button>
            <button type="button" class="live-stop" id="${P}Stop-${kind}" hidden>Stop</button>
            ${kind === 'fund' ? `<button type="button" class="live-stop" id="${P}Perm" title="Opens this page's permissions so you can allow Claude" hidden>Open permissions</button>` : ''}
          </div>
          <div class="live-progress" id="${P}Bar-${kind}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden><div class="live-progress-fill" id="${P}Fill-${kind}"></div></div>
          <div class="live-status" id="${P}Status-${kind}"></div>
        </div>`;
  return `<div class="live-refresh-grid">${['fund', 'tech'].filter(k => btnIds[k]).map(card).join('')}</div>`;
}

export { createBatchRounds, liveCardsHtml, paintBatchCards };
