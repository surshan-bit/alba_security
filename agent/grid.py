#!/usr/bin/env python3
"""Entry x exit x regime grid. Usage: python3 grid.py DIR [--json out.json]"""
import sys, json
import backtest as B
EXITS = {'A fixed+10%': {'kind': 'fixed10', 'weeks': 5}, 'C 1:3+gate': {'kind': 'rr', 'rr': 3, 'weeks': 10, 'gate': True}}
ENTRIES = ['base', 'breakout', 'rs', 'pullback', 'bo_rs']
REGIMES = {'none': None, 'sma10>=50%': ('sma10', .5), 'mom4>=50%': ('mom4', .5), 'mom4>=60%': ('mom4', .6)}
def half(trades, curve, t0, t1):
    cv = [(t, e) for t, e in curve if t0 <= t <= t1]
    if not cv: return B.stats([], [])
    e0 = cv[0][1]; return B.stats([x for x in trades if t0 <= x['t'] <= t1], [(t, e / e0 * B.CAP) for t, e in cv])
def main(d, out=None):
    S = B.load(d); times = sorted({b[0] for v in S.values() for b in v}); start, end = times[60], times[-1]; mid = times[60 + (len(times) - 60) // 2]
    res = {'stocks': len(S), 'universe%': B.universe_return(S, start, end), 'rows': []}
    for en in ENTRIES:
        for xn, x in EXITS.items():
            for rn, rg in REGIMES.items():
                rule = dict(x, entry=en); 
                if rg: rule['regime'] = rg
                tr, cv = B.run(S, rule, start, end)
                res['rows'].append({'entry': en, 'exit': xn, 'regime': rn, 'all': B.stats(tr, cv), 'h1': half(tr, cv, start, mid), 'h2': half(tr, cv, mid + 1, end)})
                r = res['rows'][-1]; a, h1, h2 = r['all'], r['h1'], r['h2']
                print('%-9s %-12s %-11s n=%-4s hit=%-5s avg=%-6s PF=%-5s tot=%-7s dd=%-7s | H1 %-7s H2 %-7s' % (en, xn, rn, a['trades'], a['hit%'], a['avgRet%'], a['PF'], a['total%'], a['maxDD%'], h1['total%'], h2['total%']), flush=True)
    if out: json.dump(res, open(out, 'w'), indent=1)
    return res
if __name__ == '__main__':
    main(sys.argv[1], sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None)
