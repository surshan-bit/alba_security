#!/usr/bin/env python3
"""Rocky backtest: replay weekly bars and compare exit/gate rule sets on the same entry signals.

Usage: python3 backtest.py DIR [--json out.json]
DIR holds priceHistory docs (*_1W.json; bars = [t_open_unix, o, h, l, c, v]).

What it can and cannot tell you (read before trusting a number):
- Tests ONLY price/volume rules (trend, risk/reward, exits). Fundamentals, MoS and verdicts are not point-in-time
  in the data, so they are not replayed.
- Survivorship bias: the stocks are those tracked today. No industry-group cap (no group data in price docs).
- Weekly bars: if stop and target both fall inside one bar the stop is assumed first (pessimistic).
- Bars are keyed by Monday-aligned week number. Entry = next week's open after the signal week's close. Gaps through a stop fill at the open.
- Costs: 0.5% round trip, as in agent.py.
"""
import glob, json, os, sys, math
CAP = 1_000_000; RISK = 0.01; MAXPOS = 8; POSCAP = 0.125; COST = 0.005
MINWK = 2650   # first week used (~Nov 2020): keeps the five-year window all stocks share

def load(d):
    S = {}
    for f in sorted(glob.glob(os.path.join(d, '*_1W.json'))):
        try: j = json.load(open(f))
        except Exception: continue
        b = j.get('bars') or []
        if len(b) < 60: continue
        rows = {}
        for x in b[:-1]:                                                          # drop the still-forming last bar
            wk = int((x[0] + 19800 - 4 * 86400) // 604800)                          # Monday-aligned IST week number
            rows[wk] = [wk] + list(map(float, x[1:6]))
        ks = [k for k in sorted(rows) if k >= MINWK]
        if len(ks) < 60 or max(b - a for a, b in zip(ks, ks[1:])) > 3: continue    # sparse/illiquid series break lookbacks
        S[os.path.basename(f)[:-8]] = [rows[k] for k in ks]
    return S

def sma(a, n): return sum(a[-n:]) / n
def rsi(c, n=14):
    g = [max(c[i] - c[i - 1], 0) for i in range(len(c) - n, len(c))]; l = [max(c[i - 1] - c[i], 0) for i in range(len(c) - n, len(c))]
    ag, al = sum(g) / n, sum(l) / n
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
def clip(x, a, b): return max(a, min(b, x))

def signal(bars, i):
    """Entry candidate at the close of bar i. Returns dict or None. Same for every rule set."""
    if i < 52: return None
    w = bars[:i + 1]; c = [x[4] for x in w]; close = c[-1]
    if sma(c, 10) > close or sma(c, 10) < sma(c[:-3], 10): return None            # >10w SMA (~50 DMA) and rising
    r = rsi(c)
    if not 45 <= r <= 75: return None
    if close / c[-5] - 1 <= 0 or close / c[-5] - 1 < -0.15: return None            # 4-week momentum positive
    hi52 = max(x[2] for x in w[-52:]); hi40 = max(x[2] for x in w[-40:])
    if close < 0.85 * hi40: return None                                            # near highs
    if sum(x[4] * x[5] for x in w[-8:]) / 8 < 50e5: return None                     # weekly turnover >= 50 lakh (liquidity)
    atr = sum((x[2] - x[3]) / x[4] for x in w[-8:]) / 8 * 100
    vol_up = w[-1][5] > 1.2 * sum(x[5] for x in w[-9:-1]) / 8                       # volume surge (reported, used by one rule set)
    score = (close / c[-13] - 1) * 100 + 20 * (close / hi40)
    return {'close': close, 'atr': atr, 'hi52': hi52, 'low3': min(x[3] for x in w[-3:]), 'score': score, 'volup': vol_up, 'rsi': r}

def plan(rule, s, entry):
    """Return (stop, target, ok). rule: dict(kind='fixed10'|'rr', rr=3, gate=bool, ...)"""
    sp = clip(s['atr'] * 0.9, 4.5, 9.0) / 100
    stop = entry * (1 - sp)
    if rule['kind'] == 'fixed10':
        return stop, entry * 1.10, True
    stop = min(stop, s['low3'] * 0.995) if rule.get('swing_stop') else stop
    stop = max(stop, entry * (1 - 0.15))                                          # never risk more than 15%
    risk = entry - stop
    target = entry + rule['rr'] * risk
    ok = True
    if rule.get('gate'):                                                          # headroom to resistance for the target
        ok = (s['hi52'] >= target) or (entry >= 0.97 * s['hi52'])
    if rule.get('need_volup') and not s['volup']: ok = False
    return stop, target, ok

def run(S, rule, t0=None, t1=None):
    times = sorted({b[0] for v in S.values() for b in v}); idx = {k: {b[0]: n for n, b in enumerate(v)} for k, v in S.items()}
    cash = CAP; opn = []; trades = []; curve = []
    # equal-weight universe proxy (weekly close-to-close mean return) for context
    for ti, t in enumerate(times[:-1]):
        if (t0 and t < t0) or (t1 and t > t1): continue
        nt = times[ti + 1]
        # 1) manage open positions through THIS week's bar
        keep = []
        for p in opn:
            n = idx[p['k']].get(t); 
            if n is None: keep.append(p); continue
            _, o, h, l, c, _ = S[p['k']][n]
            if n == p['n0']: keep.append(p); continue                              # entry bar handled below
            why = None; px = None
            if o <= p['stop']: why, px = 'stop', o
            elif l <= p['stop']: why, px = 'stop', p['stop']
            elif o >= p['target']: why, px = 'target', o
            elif h >= p['target']: why, px = 'target', p['target']
            elif n - p['n0'] >= rule['weeks']: why, px = 'time', c
            if not why:
                if rule.get('be_at') and h >= p['entry'] + rule['be_at'] * p['risk'] and p['stop'] < p['entry']: p['stop'] = p['entry']
                if rule.get('trail') and h >= p['entry'] + rule['trail'][0] * p['risk']: p['stop'] = max(p['stop'], h - rule['trail'][1] * p['risk'])
                p['last'] = c; keep.append(p); continue
            ex = px * (1 - COST / 2); cash += ex * p['q']
            trades.append({'k': p['k'], 'ret': (ex / p['entry'] - 1) * 100, 'r': (ex - p['entry']) / p['risk'], 'pnl': (ex - p['entry']) * p['q'], 'why': why, 't': t})
        opn = keep
        # 2) entries decided at close of week t, filled at open of week nt
        if len(opn) < MAXPOS:
            eq = cash + sum(p['last'] * p['q'] for p in opn)
            if rule.get('regime') and not regime_ok(S, idx, t): cands = []
            else:
                held = {p['k'] for p in opn}; cands = []
                for k, v in S.items():
                    if k in held: continue
                    n = idx[k].get(t); n2 = idx[k].get(nt)
                    if n is None or n2 is None: continue
                    s = signal(v, n)
                    if s: cands.append((s['score'], k, s, n2))
                cands.sort(key=lambda x: -x[0])
            for _, k, s, n2 in cands:
                if len(opn) >= MAXPOS: break
                o = S[k][n2][1]; entry = o * (1 + COST / 2)
                stop, target, ok = plan(rule, s, entry)
                if not ok or stop >= entry: continue
                risk = entry - stop
                q = int(min(eq * RISK / risk, eq * POSCAP / entry, cash / entry))
                if q < 1: continue
                cash -= q * entry
                opn.append({'k': k, 'n0': n2, 'entry': entry, 'q': q, 'stop': stop, 'target': target, 'risk': risk, 'last': o})
        curve.append((t, cash + sum(p['last'] * p['q'] for p in opn)))
    for p in opn:                                                                  # mark open positions at last price
        cash += p['last'] * p['q']
    return trades, curve

def regime_ok(S, idx, t):
    """Market filter: equal-weight universe index above its 10-week average."""
    ups = tot = 0
    for k, v in S.items():
        n = idx[k].get(t)
        if n is None or n < 10: continue
        tot += 1; ups += v[n][4] > sum(x[4] for x in v[n - 9:n + 1]) / 10
    return tot > 0 and ups / tot >= 0.5

def stats(trades, curve):
    n = len(trades); w = [x for x in trades if x['ret'] > 0]; l = [x for x in trades if x['ret'] <= 0]
    gw = sum(x['pnl'] for x in w); gl = -sum(x['pnl'] for x in l)
    eq = [CAP] + [c[1] for c in curve]; peak = CAP; mdd = 0
    for e in eq: peak = max(peak, e); mdd = min(mdd, (e / peak - 1) * 100)
    yrs = max(len(curve) / 52, 1e-9)
    return {'trades': n, 'hit%': round(len(w) / n * 100, 1) if n else None, 'avgRet%': round(sum(x['ret'] for x in trades) / n, 2) if n else None,
            'avgWin%': round(sum(x['ret'] for x in w) / len(w), 2) if w else None, 'avgLoss%': round(sum(x['ret'] for x in l) / len(l), 2) if l else None,
            'expR': round(sum(x['r'] for x in trades) / n, 2) if n else None, 'PF': round(gw / gl, 2) if gl else None,
            'total%': round((eq[-1] / CAP - 1) * 100, 1), 'CAGR%': round(((eq[-1] / CAP) ** (1 / yrs) - 1) * 100, 1) if eq[-1] > 0 else None, 'maxDD%': round(mdd, 1),
            'stop%': round(sum(x['why'] == 'stop' for x in trades) / n * 100) if n else None, 'target%': round(sum(x['why'] == 'target' for x in trades) / n * 100) if n else None}

def universe_return(S, t0, t1):
    r = []
    for v in S.values():
        a = [b for b in v if t0 <= b[0] <= t1]
        if len(a) > 20: r.append(a[-1][4] / a[0][4] - 1)
    return round(sum(r) / len(r) * 100, 1) if r else None

RULES = {
    'A current (+10% fixed, ATR stop, 5w)': {'kind': 'fixed10', 'weeks': 5},
    'B 1:3 target, ATR stop, 10w':          {'kind': 'rr', 'rr': 3, 'weeks': 10},
    'C B + headroom gate':                  {'kind': 'rr', 'rr': 3, 'weeks': 10, 'gate': True},
    'D C + breakeven at +1.5R':             {'kind': 'rr', 'rr': 3, 'weeks': 10, 'gate': True, 'be_at': 1.5},
    'E D + market regime filter':           {'kind': 'rr', 'rr': 3, 'weeks': 10, 'gate': True, 'be_at': 1.5, 'regime': True},
    'F 1:3 + swing-low stop + trail':       {'kind': 'rr', 'rr': 3, 'weeks': 10, 'gate': True, 'swing_stop': True, 'trail': (2.0, 1.5)},
}

def main(d, out=None):
    S = load(d); times = sorted({b[0] for v in S.values() for b in v})
    # warm-up: signals need 52 bars, so the first tradable week is index 52 of the longest series
    start = times[60]; mid = times[60 + (len(times) - 60) // 2]; end = times[-1]
    res = {'stocks': len(S), 'weeks': len(times) - 60, 'universeEqualWeightBuyHold%': universe_return(S, start, end), 'rules': {}}
    for name, rule in RULES.items():
        tr, cv = run(S, rule, start, end); r = {'all': stats(tr, cv)}
        tr1, cv1 = run(S, rule, start, mid); tr2, cv2 = run(S, rule, mid, end)
        r['firstHalf'] = stats(tr1, cv1); r['secondHalf'] = stats(tr2, cv2); res['rules'][name] = r
    if out: json.dump(res, open(out, 'w'), indent=1)
    return res

def show(res):
    print('stocks', res['stocks'], '| tradable weeks', res['weeks'], '| equal-weight universe buy&hold over the window: %s%%' % res['universeEqualWeightBuyHold%'])
    cols = ['trades', 'hit%', 'avgRet%', 'avgWin%', 'avgLoss%', 'expR', 'PF', 'total%', 'CAGR%', 'maxDD%', 'stop%', 'target%']
    for part in ('all', 'firstHalf', 'secondHalf'):
        print('\n== %s ==' % part); print('%-36s' % 'rule' + ''.join('%9s' % c for c in cols))
        for name, r in res['rules'].items(): print('%-36s' % name + ''.join('%9s' % r[part][c] for c in cols))

if __name__ == '__main__':
    out = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
    show(main(sys.argv[1], out))
