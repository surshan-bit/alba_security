import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import backtest as B

def series(n=80, px=100.0):
    return [[i, px, px, px, px, 1e6] for i in range(n)]

class Fills(unittest.TestCase):
    def setUp(self):
        self.orig = B.signal
        B.signal = lambda bars, i, *a: ({'close': 100, 'atr': 5.0, 'hi52': 200, 'low3': 99, 'score': 1, 'volup': True, 'rsi': 60} if i == 60 else None)
    def tearDown(self): B.signal = self.orig
    def trade(self, bar62, rule=None, extra=None):
        v = series(); v[62] = bar62                    # entry fills at open of bar 61 (price 100)
        for i, b in (extra or {}).items(): v[i] = b
        tr, _ = B.run({'X': v}, rule or {'kind': 'rr', 'rr': 3, 'weeks': 10}, 0, 70)
        return tr
    def test_stop_hit(self):
        t = self.trade([62, 100, 100, 90, 95, 1e6]); self.assertEqual(t[0]['why'], 'stop')
    def test_gap_through_stop_fills_at_open(self):
        t = self.trade([62, 80, 80, 80, 80, 1e6]); self.assertLess(t[0]['ret'], -19)   # filled at 80, not at the stop
    def test_target_hit(self):
        t = self.trade([62, 100, 120, 100, 118, 1e6]); self.assertEqual(t[0]['why'], 'target'); self.assertGreater(t[0]['r'], 2.5)
    def test_same_bar_stop_wins(self):
        t = self.trade([62, 100, 130, 90, 100, 1e6]); self.assertEqual(t[0]['why'], 'stop')
    def test_time_exit(self):
        tr, _ = B.run({'X': series()}, {'kind': 'rr', 'rr': 3, 'weeks': 5}, 0, 70); self.assertEqual(tr[0]['why'], 'time')
    def test_breakeven_stop_moves(self):
        rule = {'kind': 'rr', 'rr': 3, 'weeks': 10, 'be_at': 1.5}
        t = self.trade([62, 100, 109, 100, 105, 1e6], rule, {63: [63, 105, 105, 99, 100, 1e6]})   # +1.5R touched, then falls back to ~entry
        self.assertEqual(t[0]['why'], 'stop'); self.assertGreater(t[0]['ret'], -2)               # exits near breakeven, not at -4.5%
    def test_costs_charged(self):
        tr, _ = B.run({'X': series()}, {'kind': 'rr', 'rr': 3, 'weeks': 5}, 0, 70); self.assertAlmostEqual(tr[0]['ret'], -0.5, delta=0.01)

class Plan(unittest.TestCase):
    S = {'close': 100, 'atr': 5.0, 'hi52': 120, 'low3': 99, 'score': 1, 'volup': False}
    def test_fixed10(self):
        stop, tgt, ok = B.plan({'kind': 'fixed10'}, self.S, 100); self.assertAlmostEqual(tgt, 110); self.assertTrue(ok)
    def test_rr_target_is_3x_risk(self):
        stop, tgt, ok = B.plan({'kind': 'rr', 'rr': 3}, self.S, 100); self.assertAlmostEqual(tgt - 100, 3 * (100 - stop))
    def test_gate_rejects_no_headroom(self):
        _, _, ok = B.plan({'kind': 'rr', 'rr': 3, 'gate': True}, dict(self.S, hi52=110), 100); self.assertFalse(ok)   # target ~113.5 sits above the 52w high 110
    def test_gate_accepts_room_or_breakout(self):
        s = dict(self.S, hi52=200); self.assertTrue(B.plan({'kind': 'rr', 'rr': 3, 'gate': True}, s, 100)[2])
        s = dict(self.S, hi52=101); self.assertTrue(B.plan({'kind': 'rr', 'rr': 3, 'gate': True}, s, 100)[2])  # at the 52w high

class Stats(unittest.TestCase):
    def test_stats(self):
        tr = [{'ret': 10, 'r': 2, 'pnl': 100, 'why': 'target'}, {'ret': -5, 'r': -1, 'pnl': -50, 'why': 'stop'}]
        s = B.stats(tr, [(0, 1.0e6), (1, 1.1e6), (2, 0.99e6)]); self.assertEqual(s['hit%'], 50.0); self.assertEqual(s['PF'], 2.0); self.assertEqual(s['maxDD%'], -10.0)

if __name__ == '__main__': unittest.main()
