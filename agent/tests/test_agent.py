import json, os, sys, tempfile, unittest, datetime as dt
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import agent as A

DAY = A.today()
def days_ago(n): return (dt.date.fromisoformat(DAY) - dt.timedelta(days=n)).isoformat()

def row(k, close, **kw):
    # c = close, wMA, wSig, mMA, mSig, rsiW, rsiM, ch1w, ch1m, vol, mcap, earn
    c = [close, 2, 1, 2, 1, 58, 55, 1, 10, 200000, 1e4, None]
    for i, v in kw.items(): c[int(i[1:])] = v
    return {'k': k, 'c': c}

def comp(k, g='G1', iv=200, sc=8, vd='buy', atr=5.0, hi=110):
    return {'n': k, 'g': g, 'sc': sc, 'vd': vd, 'iv': iv, 'atr': atr, 'hi': hi}

class Env:
    def __init__(self, stocks, rows, state=None, weights=None):
        self.t = tempfile.TemporaryDirectory(); w = self.t.name; self.w = w
        os.makedirs(w + '/agent'); os.makedirs(w + '/liveSnapshot')
        json.dump({'stocks': stocks}, open(w + '/agent/compact.json', 'w'))
        json.dump({'asof': DAY, 'rows': rows}, open(w + '/liveSnapshot/c001.json', 'w'))
        if state: json.dump(state, open(w + '/agent/state.json', 'w'))
        if weights: json.dump(weights, open(w + '/agent/weights.json', 'w'))
    def run(self, nifty=None):
        A.daily(self.w, nifty); return {n: A.J('%s/agent/%s.json' % (self.w, n)) for n in ('state', 'picks', 'log')}

def pos(k, entry=100, stop=94, target=110, d=None, q=10, g='G1'):
    return {'k': k, 'n': k, 'g': g, 'd': d or days_ago(1), 'entry': entry, 'q': q, 'stop': stop, 'target': target, 'f': {n: .5 for n in A.FEATS}, 'last': entry}

def st(open_=(), cash=A.CAP, closed=()):
    return {'cash': cash, 'open': list(open_), 'closed': list(closed), 'curve': [], 'started': DAY}

class Exits(unittest.TestCase):
    def exit_reason(self, close, **kw):
        e = Env({}, [row('X', close)], st([pos('X', **kw)], cash=0))
        s = e.run()['state']
        return s['closed'][0]['why'] if s['closed'] else None
    def test_stop(self): self.assertEqual(self.exit_reason(93), 'stop')
    def test_target(self): self.assertEqual(self.exit_reason(111), 'target')
    def test_time(self): self.assertEqual(self.exit_reason(100, d=days_ago(30)), 'time')
    def test_hold(self): self.assertIsNone(self.exit_reason(100, d=days_ago(29)))
    def test_exit_charges_half_cost(self):
        e = Env({}, [row('X', 111)], st([pos('X')], cash=0)); c = e.run()['state']['closed'][0]
        self.assertAlmostEqual(c['exit'], round(111 * (1 - A.COST / 2), 2))

class Entries(unittest.TestCase):
    def test_opens_pick_with_risk_sizing_and_cost(self):
        e = Env({'A': comp('A')}, [row('A', 100)]); r = e.run(); p = r['state']['open'][0]
        self.assertAlmostEqual(p['entry'], round(100 * (1 + A.COST / 2), 2))
        self.assertAlmostEqual(p['target'] / p['entry'] - 1, A.TARGET / 100, places=2)
        sp = 1 - p['stop'] / p['entry']
        self.assertTrue(.045 - 1e-3 <= sp <= .09 + 1e-3)
        self.assertLessEqual(p['q'] * p['entry'], A.CAP * A.POSCAP + p['entry'])
    def test_stop_distance_clipped(self):
        for atr, lo, hi in ((1, .045, .045), (20, .09, .09)):
            e = Env({'A': comp('A', atr=atr)}, [row('A', 100)]); p = e.run()['state']['open'][0]
            self.assertAlmostEqual(1 - p['stop'] / p['entry'], lo, places=2)
    def test_group_cap(self):
        stocks = {k: comp(k, g='SAME') for k in 'ABCD'}
        e = Env(stocks, [row(k, 100) for k in 'ABCD']); s = e.run()['state']
        self.assertEqual(len(s['open']), A.MAX_PER_GROUP)
    def test_max_positions(self):
        stocks = {'S%d' % i: comp('S%d' % i, g='G%d' % i) for i in range(12)}
        e = Env(stocks, [row(k, 100) for k in stocks]); self.assertEqual(len(e.run()['state']['open']), A.MAXPOS)
    def test_held_stock_not_reopened(self):
        e = Env({'A': comp('A')}, [row('A', 100)], st([pos('A', stop=50, target=500)], cash=A.CAP)); self.assertEqual(len(e.run()['state']['open']), 1)

class Blocks(unittest.TestCase):
    def blocked(self, m=None, **c):
        e = Env({'A': m or comp('A')}, [row('A', 100, **c)]); r = e.run()
        return not r['state']['open'] and r['picks']['blocked'] == 1
    def test_avoid(self): self.assertTrue(self.blocked(comp('A', vd='avoid')))
    def test_downtrend(self): self.assertTrue(self.blocked(c1=1, c2=2, c3=1, c4=2))
    def test_rsi_stretched(self): self.assertTrue(self.blocked(c5=85))
    def test_falling_knife(self): self.assertTrue(self.blocked(c8=-16))
    def test_thin_trading(self): self.assertTrue(self.blocked(c9=10))
    def test_results_within_7_days(self):
        ts = (dt.datetime.fromisoformat(DAY) + dt.timedelta(days=3)).replace(tzinfo=dt.timezone.utc).timestamp()
        self.assertTrue(self.blocked(c11=ts))
    def test_results_far_away_ok(self):
        ts = (dt.datetime.fromisoformat(DAY) + dt.timedelta(days=30)).replace(tzinfo=dt.timezone.utc).timestamp()
        self.assertFalse(self.blocked(c11=ts))

class Ledger(unittest.TestCase):
    def test_equity_is_cash_plus_positions_and_curve_idempotent(self):
        e = Env({}, [row('X', 105)], st([pos('X', q=10)], cash=1000))
        e.run(nifty=22000); s = e.run()['state']
        self.assertEqual(len(s['curve']), 1)
        self.assertEqual(s['curve'][0][1], 2050)

class Learning(unittest.TestCase):
    def weekly(self, n_closed, win_f=.9, lose_f=.1):
        w = tempfile.mkdtemp(); os.makedirs(w + '/agent')
        closed = [{'ret': 5 if i % 2 == 0 else -5, 'f': {n: (win_f if i % 2 == 0 else lose_f) for n in A.FEATS}} for i in range(n_closed)]
        json.dump(st(closed=closed), open(w + '/agent/state.json', 'w')); A.weekly(w)
        return A.J(w + '/agent/weights.json'), A.J(w + '/agent/learn.json')
    def test_no_learning_below_20(self):
        wd, ln = self.weekly(19); self.assertEqual(wd['w'], A.W0); self.assertEqual(wd['v'], 0); self.assertIn('note', ln)
    def test_learns_at_20_in_small_steps(self):
        wd, ln = self.weekly(20); self.assertEqual(wd['v'], 1)
        for n in A.FEATS:
            self.assertGreater(wd['w'][n], A.W0[n]); self.assertLess(wd['w'][n] - A.W0[n], 0.5)
            self.assertLessEqual(wd['w'][n], 3.0)

if __name__ == '__main__': unittest.main()
