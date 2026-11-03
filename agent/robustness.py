#!/usr/bin/env python3
"""How much do results depend on WHICH valid candidates are picked? Runs each rule with several random candidate orderings
(plus the real ranking). A real edge should be positive for most seeds, not just for one ranking.
Usage: python3 robustness.py DIR [seeds]"""
import sys, statistics as st
import backtest as B
EX = {'A fixed+10%': {'kind': 'fixed10', 'weeks': 5}, 'C 1:3+gate': {'kind': 'rr', 'rr': 3, 'weeks': 10, 'gate': True}}
RG = {'none': None, 'mom4>=50%': ('mom4', .5), 'mom4>=60%': ('mom4', .6)}
def main(d, seeds=8, entries=('base',)):
    S = B.load(d); times = sorted({b[0] for v in S.values() for b in v}); a, z = times[60], times[-1]; rows = []
    for en in entries:
        for xn, x in EX.items():
            for rn, rg in RG.items():
                tot = []; pf = []
                for sd in range(seeds):
                    rule = dict(x, entry=en, rank_seed=sd)
                    if rg: rule['regime'] = rg
                    s = B.stats(*B.run(S, rule, a, z)); tot.append(s['total%']); pf.append(s['PF'] or 0)
                rows.append((en, xn, rn, tot, pf))
                print('%-9s %-12s %-10s total%% median %7.1f  min %7.1f  max %7.1f  positive %d/%d | median PF %.2f' % (en, xn, rn, st.median(tot), min(tot), max(tot), sum(t > 0 for t in tot), seeds, st.median(pf)), flush=True)
    return rows
if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 8, tuple(sys.argv[3].split(',')) if len(sys.argv) > 3 else ('base',))
